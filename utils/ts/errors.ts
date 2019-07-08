import { VError } from 'verror'

enum MixerErrorNames {
    BACKEND_ECHO_MSG_BLANK = 'BACKEND_ECHO_MSG_BLANK',
    BACKEND_MIX_PROOF_INVALID = 'BACKEND_MIX_PROOF_INVALID',
    BACKEND_MIX_SIGNAL_INVALID = 'BACKEND_MIX_SIGNAL_INVALID',
    BACKEND_MIX_SIGNAL_HASH_INVALID = 'BACKEND_MIX_SIGNAL_HASH_INVALID',
    BACKEND_MIX_SIGNAL_AND_SIGNAL_HASH_INVALID = 'BACKEND_MIX_SIGNAL_AND_SIGNAL_HASH_INVALID',
    BACKEND_MIX_EXTERNAL_NULLIFIER_INVALID = 'BACKEND_MIX_EXTERNAL_NULLIFIER_INVALID',
    BACKEND_MIX_BROADCASTER_ADDRESS_INVALID = 'BACKEND_MIX_BROADCASTER_ADDRESS_INVALID',
}

const errorCodes = {
    BACKEND_ECHO_MSG_BLANK: -32000,
    BACKEND_MIX_PROOF_INVALID: -33000,
    BACKEND_MIX_SIGNAL_INVALID: -33001,
    BACKEND_MIX_SIGNAL_HASH_INVALID: -33002,
    BACKEND_MIX_SIGNAL_AND_SIGNAL_HASH_INVALID: -33003,
    BACKEND_MIX_EXTERNAL_NULLIFIER_INVALID: -33004,
    BACKEND_MIX_BROADCASTER_ADDRESS_INVALID: -33005,
}

interface MixerError {
    name: MixerErrorNames
    message: string
    cause?: any
}

/*
 * Convenience function to create and return a VError
 */
const genError = (
    name: MixerErrorNames,
    message: string,
    cause?: any,
) => {

    return new VError({
        name,
        message,
        cause
    })
}

export {
    MixerErrorNames,
    MixerError,
    genError,
    errorCodes,
}
