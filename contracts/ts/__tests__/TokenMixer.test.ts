require('module-alias/register')
// Make Typescript happy
declare var assert: any
declare var before: any
require('events').EventEmitter.defaultMaxListeners = 0

const path = require('path');
import * as etherlime from 'etherlime-lib'
import * as ethers from 'ethers'

import { config } from 'mixer-config'
import {
    mixERC20,
    genDepositProof,
    areEqualAddresses,
    getSnarks,
} from './utils'

import { sleep } from 'mixer-utils'
import {
    SnarkProvingKey,
    SnarkVerifyingKey,
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
    unstringifyBigInts,
    setupTree,
} from 'mixer-crypto'

import { genAccounts } from '../accounts'
import buildMiMC from '../buildMiMC'
const Mixer = require('@mixer-contracts/compiled/Mixer.json')
const ERC20Mintable = require('@mixer-contracts/compiled/ERC20Mintable.json')

import {
    deployAllContracts,
} from '../deploy/deploy'

const accounts = genAccounts()
const depositorAddress = accounts[0].address
const recipientAddress = accounts[1].address
let relayerAddress = accounts[2].address

const mixAmtEth = ethers.utils.parseEther(config.get('mixAmtEth').toString())
const mixAmtTokens = ethers.utils.bigNumberify(config.get('mixAmtTokens').toString())
const feeAmt = config.get('feeAmtTokens')

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
let tokenContract
let externalNullifier : string

describe('Token Mixer', () => {

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
            depositorAddress,
        )
        mimcContract = contracts.mimcContract
        semaphoreContract = contracts.tokenSemaphoreContract
        mixerContract = contracts.tokenMixerContract
        relayerRegistryContract = contracts.relayerRegistryContract
        tokenContract = contracts.tokenContract

        // mint tokens
        await tokenContract.mint(depositorAddress, 1000)
    })

    describe('Contract deployments', () => {

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

        it('should generate identity commitments', async () => {
            for (const user of users) {
                assert.isTrue(identities[user].identityCommitment.toString(10).length > 0)
            }
        })

        it('should fail to call deposit() (which is for ETH only)', async () => {
            let reason: string = ''
            let tx
            try {
                tx = await mixerContract.deposit('0x' + identityCommitment.toString(16))
                const receipt = await mixerContract.verboseWaitForTransaction(tx)
            } catch (err) {
                reason = err.data[err.transactionHash].reason
            }
            assert.equal(reason, 'Mixer: only supports ETH')
        })

        it('should perform a token deposit', async () => {
            await tokenContract.approve(mixerContract.contractAddress, mixAmtTokens)

            const balanceBefore = await tokenContract.balanceOf(depositorAddress)
            assert.isTrue(balanceBefore > 0)

            // make a deposit
            const tx = await mixerContract.depositERC20(identityCommitment.toString())
            const receipt = await mixerContract.verboseWaitForTransaction(tx)

            const gasUsed = receipt.gasUsed.toString()
            console.log('Gas used for this deposit:', gasUsed)

            nextIndex = 0

            // check that the leaf was added to the leaf history array in the contract
            const leaves = (await mixerContract.getLeaves()).map((x) => {
                return x.toString(10)
            })
            assert.include(leaves, identityCommitment.toString())
            const balanceAfter = await tokenContract.balanceOf(depositorAddress)

            assert.equal(balanceBefore - balanceAfter, mixAmtTokens)
        })

        it('should make a token withdrawal', async () => {
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

            // check inputs to mixERC20() using preBroadcastCheck()
            const preBroadcastChecked = await semaphoreContract.preBroadcastCheck(
                mixInputs.a,
                mixInputs.b,
                mixInputs.c,
                mixInputs.input,
                signalHash.toString(),
            )

            assert.isTrue(preBroadcastChecked)

            recipientBalanceBefore = await tokenContract.balanceOf(recipientAddress)
            relayerBalanceBefore = await tokenContract.balanceOf(relayerAddress)

            const mixTx = await mixERC20(
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

            recipientBalanceAfter = await tokenContract.balanceOf(recipientAddress)
            relayerBalanceAfter = await tokenContract.balanceOf(relayerAddress)

            const gasUsed = mixReceipt.gasUsed.toString()
            console.log('Gas used for this withdrawal:', gasUsed)
        })

        it('should increase the relayer\'s token balance', () => {
            relayerBalanceDiff = relayerBalanceAfter.sub(relayerBalanceBefore)
            assert.equal(relayerBalanceDiff, feeAmt)
        })

        it('should increase the recipient\'s token balance', () => {
            recipientBalanceDiff = recipientBalanceAfter.sub(recipientBalanceBefore)
            assert.isTrue(recipientBalanceDiff.eq(mixAmtTokens.sub(feeAmt)))
        })
    })
})
