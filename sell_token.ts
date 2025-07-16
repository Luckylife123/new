import dotenv from 'dotenv';
import axios from 'axios';
import {
    BigNumberish,
    Liquidity,
    LiquidityPoolKeys,
    LiquidityStateV4,
    Token,
    TokenAmount,
    LIQUIDITY_STATE_LAYOUT_V4,
} from '@raydium-io/raydium-sdk';
import {
    AccountLayout,
    createCloseAccountInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
    Keypair,
    Connection,
    PublicKey,
    ComputeBudgetProgram,
    TransactionMessage,
    VersionedTransaction,
    Commitment,
} from '@solana/web3.js';
import pino from 'pino';
import bs58 from 'bs58';
import { RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, createPoolKeys } from './liquidity';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';

dotenv.config();

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
        redact: ['poolKeys'],
        serializers: {
            error: pino.stdSerializers.err,
        },
        base: undefined,
    },
    transport,
);

const network = 'mainnet-beta';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || '';
const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT || '';
const commitment: Commitment = (process.env.COMMITMENT_LEVEL as Commitment) || 'confirmed';
const solanaConnection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

interface Pair {
    chainId: string;
    dexId: string;
    url: string;
    pairAddress: string;
    baseToken: {
        address: string;
        name: string;
        symbol: string;
    };
    quoteToken: {
        address: string; // Add this property
        symbol: string;
    };
    priceNative: string;
    priceUsd?: string;
    txns: {
        m5: { buys: number; sells: number };
        h1: { buys: number; sells: number };
        h6: { buys: number; sells: number };
        h24: { buys: number; sells: number };
    };
    volume: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
    priceChange: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
    liquidity?: {
        usd?: number;
        base: number;
        quote: number;
    };
    fdv?: number;
    pairCreatedAt?: number;
}

interface TokensResponse {
    schemaVersion: string;
    pairs: Pair[] | null;
}

export const retrieveTokenValueByAddressDexScreener = async (tokenAddress: string) => {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    try {
        const tokenResponse: TokensResponse = (await axios.get(url)).data;
        if (tokenResponse.pairs) {
            const pair = tokenResponse.pairs.find((pair) => pair.chainId === 'solana');
            const priceNative = pair?.priceNative;
            if (priceNative) return parseFloat(priceNative);
        }
        return undefined;
    } catch (e) {
        return undefined;
    }
};

export const retrieveTokenValueByAddressBirdeye = async (tokenAddress: string) => {
    const apiKey = process.env.BIRDEYE_API_KEY || '';
    const url = `https://public-api.birdeye.so/public/price?address=${tokenAddress}`;
    try {
        const response = (await axios.get(url, {
            headers: {
                'X-API-KEY': apiKey,
            },
        })).data.data.value;
        if (response) return parseFloat(response);
        return undefined;
    } catch (e) {
        return undefined;
    }
};

export const retrieveTokenValueByAddress = async (tokenAddress: string) => {
    const dexScreenerPrice = await retrieveTokenValueByAddressDexScreener(tokenAddress);
    if (dexScreenerPrice) return dexScreenerPrice;
    const birdEyePrice = await retrieveTokenValueByAddressBirdeye(tokenAddress);
    if (birdEyePrice) return birdEyePrice;
    return undefined;
};

export const retry = async <T>(
    fn: () => Promise<T> | T,
    { retries, retryIntervalMs }: { retries: number; retryIntervalMs: number },
): Promise<T> => {
    try {
        return await fn();
    } catch (error) {
        if (retries <= 0) {
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        return retry(fn, { retries: retries - 1, retryIntervalMs });
    }
};

type MinimalTokenAccountData = {
    mint: PublicKey;
    address: PublicKey;
    poolKeys?: LiquidityPoolKeys;
    market?: MinimalMarketLayoutV3;
};

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
const MAX_SELL_RETRIES = Number(process.env.MAX_SELL_RETRIES || 3);

async function init(): Promise<void> {
    const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
    if (!PRIVATE_KEY) {
        logger.error('PRIVATE_KEY is not set');
        process.exit(1);
    }
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    logger.info(`Wallet Address: ${wallet.publicKey}`);

    const QUOTE_MINT = process.env.QUOTE_MINT || 'WSOL';
    switch (QUOTE_MINT) {
        case 'WSOL': {
            quoteToken = Token.WSOL;
            break;
        }
        case 'USDC': {
            quoteToken = new Token(
                TOKEN_PROGRAM_ID,
                new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
                6,
                'USDC',
                'USDC',
            );
            break;
        }
        default: {
            throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
        }
    }

    const tokenAccounts = await solanaConnection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
    });
    const tokenAccount = tokenAccounts.value.find((acc) => acc.account.data.parsed.info.mint === quoteToken.mint.toString());
    if (!tokenAccount) {
        throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
    }
    quoteTokenAssociatedAddress = tokenAccount.pubkey;
}

async function getPoolIdFromDexScreener(tokenAddress: string): Promise<string | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    try {
        const tokenResponse: TokensResponse = (await axios.get(url)).data;
        if (tokenResponse.pairs) {
            const pair = tokenResponse.pairs.find(
                (pair) => pair.chainId === 'solana' && pair.quoteToken.address === quoteToken.mint.toBase58(),
            );
            return pair?.pairAddress || null;
        }
        return null;
    } catch (e) {
        logger.error({ error: e }, `Failed to fetch pool ID from DexScreener`);
        return null;
    }
}

async function sellToken(tokenAddress: string): Promise<void> {
    try {
        await init();

        const mint = new PublicKey(tokenAddress);
        const tokenAccount = await solanaConnection.getParsedTokenAccountsByOwner(wallet.publicKey, {
            mint,
        });
        if (!tokenAccount.value.length) {
            logger.info(`No token account found for mint: ${tokenAddress}`);
            return;
        }

        const accountData = tokenAccount.value[0].account.data.parsed.info;
        const amount: BigNumberish = accountData.tokenAmount.amount;

        if (parseInt(amount.toString()) === 0) {
            logger.info(`No tokens to sell for mint: ${tokenAddress}`);
            return;
        }

        const poolId = await getPoolIdFromDexScreener(tokenAddress);
        if (!poolId) {
            logger.info(`No liquidity pool found for mint: ${tokenAddress}`);
            return;
        }

        const poolAccount = await solanaConnection.getAccountInfo(new PublicKey(poolId));
        if (!poolAccount) {
            logger.info(`No liquidity pool account found for pool ID: ${poolId}`);
            return;
        }

        const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccount.data);
        const market = await getMinimalMarketV3(solanaConnection, poolState.marketId, commitment);
        const poolKeys = createPoolKeys(new PublicKey(poolId), poolState, market);

        const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
            {
                poolKeys,
                userKeys: {
                    tokenAccountIn: tokenAccount.value[0].pubkey,
                    tokenAccountOut: quoteTokenAssociatedAddress,
                    owner: wallet.publicKey,
                },
                amountIn: amount,
                minAmountOut: 0,
            },
            poolKeys.version,
        );

        const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment });
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400000 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ...innerTransaction.instructions,
                createCloseAccountInstruction(tokenAccount.value[0].pubkey, wallet.publicKey, wallet.publicKey),
            ],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet, ...innerTransaction.signers]);

        const signature = await retry(
            () => solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: true }),
            { retries: MAX_SELL_RETRIES, retryIntervalMs: 1000 },
        );

        logger.info({ mint: tokenAddress, signature }, `Sent sell transaction`);

        const confirmation = await solanaConnection.confirmTransaction(
            {
                signature,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                blockhash: latestBlockhash.blockhash,
            },
            commitment,
        );

        const currValue = await retrieveTokenValueByAddress(tokenAddress);
        if (!confirmation.value.err) {
            logger.info(
                {
                    signature,
                    url: `https://solscan.io/tx/${signature}?cluster=${network}`,
                    dex: `https://dexscreener.com/solana/${tokenAddress}?maker=${wallet.publicKey}`,
                },
                `Confirmed sell tx... Sold at: ${currValue || 'unknown'} SOL`,
            );
        } else {
            logger.error({ mint: tokenAddress, signature }, `Error confirming sell transaction`);
        }
    } catch (e) {
        logger.error({ mint: tokenAddress, error: e }, `Failed to sell token`);
    }
}

if (process.argv.length < 3) {
    logger.error('Please provide a token address as an argument: npm run sell <token_address>');
    process.exit(1);
}

const tokenAddress = process.argv[2];
sellToken(tokenAddress);