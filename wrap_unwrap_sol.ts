import {
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    Commitment,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    createSyncNativeInstruction,
    createCloseAccountInstruction,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { ComputeBudgetProgram } from '@solana/web3.js';
import pino from 'pino';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';

// Завантажуємо .env
dotenv.config();

// Налаштування логера
const transport = pino.transport({
    targets: [
        {
            level: 'trace',
            target: 'pino-pretty',
            options: {},
        },
    ],
});

export const logger = pino(
    {
        level: 'trace',
        serializers: {
            error: pino.stdSerializers.err,
        },
        base: undefined,
    },
    transport,
);

// Власна функція retrieveEnvVariable
function retrieveEnvVariable(key: string, logger: pino.Logger): string {
    const value = process.env[key];
    if (!value) {
        logger.error(`Environment variable ${key} is not set`);
        process.exit(1);
    }
    return value;
}

const network = 'mainnet-beta';
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const RPC_WEBSOCKET_ENDPOINT = 'wss://api.mainnet-beta.solana.com';
const DEFAULT_AMOUNT = 0.001;

const solanaConnection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    commitment: 'confirmed',
});
logger.info(`WS endpoint: ${RPC_WEBSOCKET_ENDPOINT}`);

let wallet: Keypair;
let commitment: Commitment;

async function init(): Promise<void> {
    commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
    const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    logger.info(`Wallet Address: ${wallet.publicKey}`);
    const balance = await solanaConnection.getBalance(wallet.publicKey);
    logger.info(`Wallet Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
}

async function wrapSol(amount: number): Promise<void> {
    try {
        const wsolAddress = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);

        // Перевірка існування токен-акаунта
        const accountInfo = await solanaConnection.getAccountInfo(wsolAddress);
        const wrapInstructions = [];

        if (!accountInfo) {
            logger.info(`Creating associated token account for WSOL: ${wsolAddress}`);
            wrapInstructions.push(
                createAssociatedTokenAccountInstruction(
                    wallet.publicKey, // payer
                    wsolAddress, // token account
                    wallet.publicKey, // owner
                    NATIVE_MINT // mint
                )
            );
        }

        wrapInstructions.push(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wsolAddress,
                lamports: Math.floor(amount * LAMPORTS_PER_SOL),
            }),
            createSyncNativeInstruction(wsolAddress, TOKEN_PROGRAM_ID)
        );

        const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment });
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ...wrapInstructions,
            ],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 5,
        });
        logger.info({ signature, amount }, `Wrapped ${amount} SOL to WSOL`);

        const confirmation = await solanaConnection.confirmTransaction(
            {
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            commitment,
        );

        if (confirmation.value.err) {
            logger.error({ signature, err: confirmation.value.err }, `Failed to confirm wrap transaction`);
            throw new Error(`Wrap transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        logger.info(`Transaction confirmed: ${signature}`);
    } catch (e) {
        logger.error(e, `Failed to wrap ${amount} SOL`);
        throw e;
    }
}

async function unwrapSol(amount?: number): Promise<void> {
    try {
        const wsolAddress = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
        const balance = await solanaConnection.getTokenAccountBalance(wsolAddress, commitment);

        if (!balance.value.uiAmount || balance.value.uiAmount === 0) {
            logger.info(`No WSOL to unwrap`);
            return;
        }

        const unwrapAmount = amount && amount <= balance.value.uiAmount ? amount : balance.value.uiAmount;
        const unwrapInstructions = [
            createCloseAccountInstruction(wsolAddress, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID),
        ];

        const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment });
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ...unwrapInstructions,
            ],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 5,
        });
        logger.info({ signature, amount: unwrapAmount }, `Unwrapped ${unwrapAmount} WSOL to SOL`);

        const confirmation = await solanaConnection.confirmTransaction(
            {
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            commitment,
        );

        if (confirmation.value.err) {
            logger.error({ signature, err: confirmation.value.err }, `Failed to confirm unwrap transaction`);
            throw new Error(`Unwrap transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        logger.info(`Transaction confirmed: ${signature}`);
    } catch (e) {
        logger.error(e, `Failed to unwrap WSOL`);
        throw e;
    }
}

async function main(action: 'wrap' | 'unwrap', amount: number = DEFAULT_AMOUNT): Promise<void> {
    await init();

    if (amount <= 0) {
        throw new Error('Amount must be greater than 0');
    }

    if (action === 'wrap') {
        await wrapSol(amount);
    } else if (action === 'unwrap') {
        await unwrapSol(amount);
    } else {
        throw new Error(`Invalid action: ${action}. Must be 'wrap' or 'unwrap'`);
    }
}

// Parse command-line arguments
const [,, action, amountStr] = process.argv;
const amount = amountStr ? parseFloat(amountStr) : DEFAULT_AMOUNT;

if (action) {
    main(action as 'wrap' | 'unwrap', amount).catch((e) => {
        logger.error(e, 'Operation failed');
        process.exit(1);
    });
} else {
    logger.error('Please provide valid action (wrap/unwrap)');
    process.exit(1);
}