require('module-alias/register')
// Make Typescript happy
declare var assert: any
declare var before: any
require('events').EventEmitter.defaultMaxListeners = 0

const fs = require('fs');
const path = require('path');
import * as etherlime from 'etherlime-lib'
import * as ethers from 'ethers'

import { config } from 'mixer-config'
import {
    mix,
    genDepositProof,
    areEqualAddresses,
    getSnarks,
} from './utils'

import { sleep } from 'mixer-utils'
import {
    genRandomBuffer,
    genIdentity,
    genIdentityCommitment,
    genIdentityNullifier,
    genEddsaKeyPair,
    genCircuit,
    genSignedMsg,
    signMsg,
    verifySignature,
    genSignalAndSignalHash,
    genWitness,
    genWitnessInputs,
    extractWitnessRoot,
    genPathElementsAndIndex,
    genProof,
    genPublicSignals,
    verifyProof,
    setupTree,
} from 'mixer-crypto'

import { genAccounts } from '../accounts'
import buildMiMC from '../buildMiMC'
const Mixer = require('@mixer-contracts/compiled/Mixer.json')

import {
    deployAllContracts,
} from '../deploy/deploy'

const accounts = genAccounts()
const recipientAddress = accounts[1].address
let relayerAddress = accounts[2].address

const mixAmtEth = ethers.utils.parseEther(config.get('mixAmtEth').toString())
const mixAmtTokens = ethers.utils.bigNumberify(config.get('mixAmtTokens').toString())
const feeAmt = ethers.utils.parseEther(
    (parseFloat(config.get('feeAmtEth'))).toString()
)

const users = accounts.slice(1, 6).map((user) => user.address)
const identities = {}

const contractsPath = path.join(
    __dirname,
    '../..',
    'compiled',
)

for (let i=0; i < users.length; i++) {
    const user = users[i]

    let keyBuf = genRandomBuffer(32)
    let idNullifierBytes = genRandomBuffer(31)

    // Generate an eddsa identity, identity nullifier, and identity commitment
    // per user
    const { privKey, pubKey } = genEddsaKeyPair(keyBuf)
    const identityNullifier = genIdentityNullifier(idNullifierBytes)
    const identityCommitment = genIdentityCommitment(identityNullifier, pubKey)

    identities[user] = {
        identityCommitment,
        identityNullifier,
        privKey,
        pubKey,
    }
}

let mimcContract
let mixerContract
let semaphoreContract
let relayerRegistryContract
let externalNullifier : string

describe('Mixer', () => {

    const deployer = new etherlime.JSONRPCPrivateKeyDeployer(
        accounts[0].privateKey,
        config.get('chain.url'),
        {
            chainId: config.get('chain.chainId'),
        },
    )
    deployer.defaultOverrides = { gasLimit: 8800000 }
    deployer.setSigner(accounts[0])

    before(async () => {
        await buildMiMC()

        const contracts = await deployAllContracts(
            deployer,
            mixAmtEth,
            mixAmtTokens,
            accounts[0].address,
        )
        mimcContract = contracts.mimcContract
        semaphoreContract = contracts.semaphoreContract
        mixerContract = contracts.mixerContract
        relayerRegistryContract = contracts.relayerRegistryContract
    })

    describe('Contract deployments', () => {

        it('should not deploy Mixer if the Semaphore contract address is invalid', async () => {
            assert.revert(
                deployer.deploy(
                    Mixer,
                    {},
                    '0x0000000000000000000000000000000000000000',
                    mixAmtEth,
                    '0x0000000000000000000000000000000000000000',
                )
            )
            await sleep(1000)
        })

        it('should not deploy Mixer if the mixAmt is invalid', async () => {
            assert.revert(
                deployer.deploy(
                    Mixer,
                    {},
                    semaphoreContract.contractAddress,
                    ethers.utils.parseEther('0'),
                    '0x0000000000000000000000000000000000000000',
                )
            )
            await sleep(1000)
        })

        it('should deploy contracts', () => {
            assert.notEqual(
                mimcContract._contract.bytecode,
                '0x',
                'the contract bytecode should not just be 0x'
            )

            assert.isAddress(mimcContract.contractAddress)
            assert.isAddress(semaphoreContract.contractAddress)
            assert.isAddress(mixerContract.contractAddress)

            // the external nullifier is the hash of the contract's address
            externalNullifier = mixerContract.contractAddress
        })

        it('the Mixer contract should be the owner of the Semaphore contract', async () => {
            assert.equal((await semaphoreContract.owner()), mixerContract.contractAddress)
        })

        it('the Semaphore contract\'s external nullifier should be the mixer contract address', async () => {
            const semaphoreExtNullifier = await semaphoreContract.external_nullifier()
            const mixerAddress = mixerContract.contractAddress
            assert.isTrue(areEqualAddresses(semaphoreExtNullifier, mixerAddress))
        })
    })

    describe('Deposits and withdrawals', () => {
        // initialise the off-chain merkle tree
        const tree = setupTree()

        // get the circuit, verifying key, and proving key
        const { verifyingKey, provingKey, circuit } = getSnarks()

        const identity = identities[users[0]]
        const identityCommitment = identity.identityCommitment
        let nextIndex

        let recipientBalanceBefore
        let recipientBalanceAfter
        let recipientBalanceDiff

        let relayerBalanceBefore
        let relayerBalanceAfter
        let relayerBalanceDiff

        let mixReceipt
        let mixTxFee

        it('should generate identity commitments', async () => {
            for (const user of users) {
                assert.isTrue(identities[user].identityCommitment.toString(10).length > 0)
            }
        })

        it('should not add the identity commitment to the contract if the amount is incorrect', async () => {
            const identityCommitment = identities[users[0]].identityCommitment
            await assert.revert(mixerContract.deposit(identityCommitment.toString(), { value: 0 }))
            await assert.revert(mixerContract.deposit(identityCommitment.toString(), { value: mixAmtEth.add(1) }))
        })

        it('should fail to call depositERC20', async () => {
            let reason: string = ''
            let tx
            try {
                tx = await mixerContract.depositERC20('0x' + identityCommitment.toString(16))
                const receipt = await mixerContract.verboseWaitForTransaction(tx)
            } catch (err) {
                reason = err.data[err.transactionHash].reason
            }
            assert.equal(reason, 'Mixer: only supports tokens')
        })

        it('should perform an ETH deposit', async () => {
            // make a deposit (by the first user)
            const tx = await mixerContract.deposit(identityCommitment.toString(), { value: mixAmtEth })
            const receipt = await mixerContract.verboseWaitForTransaction(tx)

            const gasUsed = receipt.gasUsed.toString()
            console.log('Gas used for this deposit:', gasUsed)

            // check that the leaf was added using the receipt
            assert.isTrue(utils.hasEvent(receipt, semaphoreContract.contract, 'LeafAdded'))
            const leafAddedEvent = utils.parseLogs(receipt, semaphoreContract.contract, 'LeafAdded')[0]

            nextIndex = leafAddedEvent.leaf_index
            assert.equal(nextIndex, 0)

            // check that the leaf was added to the leaf history array in the contract
            const leaves = (await mixerContract.getLeaves()).map((x) => {
                return x.toString(10)
            })
            assert.include(leaves, identityCommitment.toString())
        })

        it('should make an ETH withdrawal', async () => {
            await tree.update(nextIndex, identityCommitment.toString())

            const {
                signature,
                msg,
                signalHash,
                signal,
                identityPath,
                identityPathElements,
                identityPathIndex,
            } = await genWitnessInputs(
                tree,
                nextIndex,
                identityCommitment,
                recipientAddress,
                relayerAddress,
                feeAmt,
                identity.privKey,
                externalNullifier,
            )

            assert.isTrue(verifySignature(msg, signature, identity.pubKey))

            const w = genWitness(
                circuit,
                identity.pubKey,
                signature,
                signalHash,
                externalNullifier,
                identity.identityNullifier,
                identityPathElements,
                identityPathIndex,
            )

            const witnessRoot = extractWitnessRoot(circuit, w)
            assert.equal(witnessRoot, identityPath.root)

            assert.isTrue(circuit.checkWitness(w))

            const publicSignals = genPublicSignals(w, circuit)

            const proof = await genProof(w, provingKey.buffer)

            // verify the proof off-chain
            const isVerified = verifyProof(verifyingKey, proof, publicSignals)
            assert.isTrue(isVerified)

            const mixInputs = await genDepositProof(signal, proof, publicSignals, recipientAddress, feeAmt)

            // check inputs to mix() using preBroadcastCheck()
            const preBroadcastChecked = await semaphoreContract.preBroadcastCheck(
                mixInputs.a,
                mixInputs.b,
                mixInputs.c,
                mixInputs.input,
                signalHash.toString(),
            )

            assert.isTrue(preBroadcastChecked)

            recipientBalanceBefore = await deployer.provider.getBalance(recipientAddress)
            relayerBalanceBefore = await deployer.provider.getBalance(relayerAddress)

            const mixTx = await mix(
                relayerRegistryContract,
                mixerContract,
                signal,
                proof,
                publicSignals,
                recipientAddress,
                feeAmt,
                relayerAddress,
            )

            // Wait till the transaction is mined
            mixReceipt = await mixerContract.verboseWaitForTransaction(mixTx)

            recipientBalanceAfter = await deployer.provider.getBalance(recipientAddress)
            relayerBalanceAfter = await deployer.provider.getBalance(relayerAddress) 

            const gasUsed = mixReceipt.gasUsed.toString()
            console.log('Gas used for this withdrawal:', gasUsed)

            mixTxFee = mixTx.gasPrice.mul(mixReceipt.gasUsed)
        })

        it('should increase the relayer\'s balance', () => {
            relayerBalanceDiff = relayerBalanceAfter.sub(relayerBalanceBefore)
            assert.equal(relayerBalanceDiff.toString(), feeAmt.toString())
        })

        it('should increase the recipient\'s balance', () => {
            recipientBalanceDiff = recipientBalanceAfter.sub(recipientBalanceBefore).toString()
            assert.equal(ethers.utils.formatEther(recipientBalanceDiff), '0.099')
        })
    })
})
