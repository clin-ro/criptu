require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

// --- Express App ---
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- MongoDB Configuration ---
const MONGODB_URI = process.env.MONGODB_URI;
const PRECISION = 5;

// --- Mongoose Schemas ---
const tradeSchema = new mongoose.Schema({
    symbol: String,
    quantity: Number,
    side: String,
    price: Number,
    fee: Number,
    reason: String,
    timestamp: { type: Date, default: Date.now }
});

const balanceSchema = new mongoose.Schema({
    asset: String,
    free: Number,
    locked: Number
});

const balanceSnapShotSchema = new mongoose.Schema({
    asset: String,
    free: Number,
    locked: Number,
    timestamp: { type: Date, default: Date.now }
});

const Trade = mongoose.model('Trade', tradeSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const BalanceSnapShot = mongoose.model('BalanceSnapShot', balanceSnapShotSchema);

// --- Trading Configuration ---
const DMI_PERIOD = 14;
const SMA_PERIOD = 25;
const ALLOCATION_PER_STOCK = 0.5;
const TIMEFRAME = '1h';
const CRON_SCHEDULE = '5 * * * *';
const TRADING_FEE_RATE = 0.0004;
const INITIAL_BALANCE = 100000;

// --- Generate Tickers ---
const tickers = [
    'BTCUSDT',
    'SOLUSDT',
    'HBARUSDT',
    'RUNEUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'SUIUSDT',
    'BNBUSDT',
    'LINKUSDT',
    'AVAXUSDT',
    'NEARUSDT',
    'DOTUSDT',
    'UNIUSDT',
    'ALGOUSDT',
    'FILUSDT',
    'ATOMUSDT',
    'SOLBTC',
    'XRPBTC',
    'DOGEBTC',
    'BNBBTC',
    'SUIBTC',
    'HBARBTC',
    'LINKBTC',
    'AVAXBTC',
    'RUNEBTC',
    'DOTBTC',
    'ALGOBTC',
    'NEARBTC',
    'UNIBTC',
    'ATOMBTC',
    'FILBTC'
];
const BASE_URL = 'https://api.binance.com/api/v3';

async function connectToMongoDB() {
    try {
        await mongoose.connect(MONGODB_URI);
        await initializeBalances();
    } catch (error) {
        process.exit(1);
    }
}

async function initializeBalances() {
    const existingBalances = await Balance.countDocuments();
    if (existingBalances === 0) {
        for (const quoteAsset of QUOTE_ASSETS) {
            await new Balance({
                asset: quoteAsset,
                free: quoteAsset === 'USDT' ? INITIAL_BALANCE : 0,
                locked: 0,
            }).save();
        }
    }
}


async function getHistoricalData(symbol, period) {
    try {
        const url = `${BASE_URL}/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${period + 50}`;
        const response = await axios.get(url);
        if (response.data && response.data.length > 0) {
            return response.data.map(candle => ({
                time: candle[0],
                open: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                low: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                volume: parseFloat(candle[5])
            }));
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function getBalance() {
    try {
        const balances = await Balance.find();
        const balanceObject = {};
        balances.forEach(balance => {
            balanceObject[balance.asset] = {
                free: parseFloat(balance.free),
                locked: parseFloat(balance.locked)
            };
        });
        return balanceObject;
    } catch (error) {
        console.error('Error fetching balance from MongoDB:', error);
        return null;
    }
}

async function updateBalance(asset, change, type = 'free') {
    try {
        const balance = await Balance.findOne({ asset });
        if (balance) {
            const currentBalance = type === 'free' ? parseFloat(balance.free) : parseFloat(balance.locked);
            const newBalance = Math.max(0, currentBalance + change);

            await Balance.updateOne(
                { asset },
                { $set: { [type]: newBalance } }
            );
        } else {
            const initialBalance = Math.max(0, change);
            await new Balance({
                asset,
                free: type === 'free' ? initialBalance : 0,
                locked: type !== 'free' ? initialBalance : 0,
            }).save();
        }
    } catch (error) {
        throw error;
    }
}

function plusDI(high, low, close, period) {
    if (!high || !low || !close || high.length < period + 1 || low.length < period + 1 || close.length < period + 1) {
        return null;
    }

    let sumPositiveDM = 0;
    let sumTrueRange = 0;

    for (let i = 1; i <= period; i++) {
        const upMove = high[i] - high[i - 1];
        const downMove = low[i - 1] - low[i];

        let positiveDM = 0;
        if (upMove > downMove && upMove > 0) {
            positiveDM = upMove;
        }

        const trueRange = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );

        sumPositiveDM += positiveDM;
        sumTrueRange += trueRange;
    }

    return sumTrueRange === 0 ? 0 : (100 * sumPositiveDM / sumTrueRange);
}

function minusDI(high, low, close, period) {
    if (!high || !low || !close || high.length < period + 1 || low.length < period + 1 || close.length < period + 1) {
        return null;
    }

    let sumNegativeDM = 0;
    let sumTrueRange = 0;

    for (let i = 1; i <= period; i++) {
        const upMove = high[i] - high[i - 1];
        const downMove = low[i - 1] - low[i];

        let negativeDM = 0;
        if (downMove > upMove && downMove > 0) {
            negativeDM = downMove;
        }

        const trueRange = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1])
        );

        sumNegativeDM += negativeDM;
        sumTrueRange += trueRange;
    }

    return sumTrueRange === 0 ? 0 : (100 * sumNegativeDM / sumTrueRange);
}

function getSMA(data, period) {
    return data.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

async function analyzeTicker(symbol) {
    const historicalData = await getHistoricalData(symbol, DMI_PERIOD + 1);
    if (!historicalData || historicalData.length < DMI_PERIOD + 1) {
        return null;
    }

    const high = historicalData.map(bar => bar.high);
    const low = historicalData.map(bar => bar.low);
    const close = historicalData.map(bar => bar.close);

    const calculatedPlusDI = plusDI(high, low, close, DMI_PERIOD);
    const calculatedMinusDI = minusDI(high, low, close, DMI_PERIOD);
    const calculatedSMA = getSMA(close, SMA_PERIOD);
    if (calculatedPlusDI === null || calculatedMinusDI === null || calculatedSMA === null) {
        return null;
    }

    return {
        symbol,
        plusDI: calculatedPlusDI,
        minusDI: calculatedMinusDI,
        lastPrice: close[close.length - 1],
        sma: calculatedSMA
    };
}

async function simulateTrade(symbol, quantity, side, price) {
    try {
        if (!symbol || !quantity || !side || !price) {
            return false;
        }

        if (quantity <= 0 || price <= 0) {
            return false;
        }

        const fee = quantity * price * TRADING_FEE_RATE;
        const baseAsset = symbol.replace(/USDT|BTC|ETH/, '');
        const quoteAsset = symbol.replace(baseAsset, '');

        return {
            symbol,
            quantity,
            side,
            price,
            fee,
            baseAsset,
            quoteAsset,
            success: true
        };
    } catch (error) {
        return false;
    }
}

const QUOTE_ASSETS = ['USDT', 'BTC', 'ETH'];
const getQuoteAsset = (symbol) => {
    return QUOTE_ASSETS.find(asset => symbol.endsWith(asset));
}
const getBaseAsset = (symbol) => {
    return symbol.replace(getQuoteAsset(symbol), '');
}
const getSymbol = (baseOrQuote1, baseOrQuote2) => {
    const options = [
        `${baseOrQuote1}${baseOrQuote2}`,
        `${baseOrQuote2}${baseOrQuote1}`
    ]
    const symbol = options.find(symbol => symbol.endsWith(getQuoteAsset(symbol)));
    const sides = {
        [baseOrQuote1]: symbol.endsWith(baseOrQuote1) ? 'buy' : 'sell',
        [baseOrQuote2]: symbol.endsWith(baseOrQuote2) ? 'buy' : 'sell'
    }
    return {
        symbol,
        sides
    }
}

const getTradeVolumeFromPercentage = async (asset, percentage) => {
    const balances = await getBalance();
    if (!balances || !balances[asset]) return 0
    return (balances[asset].free * percentage) / 100;
};

const getIntoAction = async (symbol, analysis, balances) => {
    try {
        const quoteAsset = getQuoteAsset(symbol);
        const baseAsset = getBaseAsset(symbol);

        if (!quoteAsset || !baseAsset) return false;

        const { sides } = getSymbol(quoteAsset, baseAsset)

        const toBuy = analysis.plusDI > analysis.minusDI && analysis.lastPrice > analysis.sma;
        const toSell = analysis.plusDI < analysis.minusDI && analysis.lastPrice < analysis.sma;

        let from, to;

        if (toBuy) {
            from = quoteAsset;
            to = baseAsset;
        } else if (toSell) {
            from = baseAsset;
            to = quoteAsset;
        } else {
            return false;
        }

        const price = await getPrice(symbol);
        if (!price) return false;

        const availableFrom = balances[from]?.free || 0;
        if (availableFrom <= 0) {
            return false;
        }


        let quantity;
        if (sides[from] === 'sell') {
            quantity = await getTradeVolumeFromPercentage(from, 100);
        } else {
            quantity = from === quoteAsset
                ? (await getTradeVolumeFromPercentage(from, ALLOCATION_PER_STOCK)) / price
                : await getTradeVolumeFromPercentage(from, 100)
        }

        const trade = await simulateTrade(
            symbol,
            quantity,
            sides[from],
            price
        );

        return {
            ...trade,
            from,
            to,
            reason: `DMI(${analysis.plusDI.toFixed(2)}) > DMI(${analysis.minusDI.toFixed(2)}) AND ${analysis.lastPrice.toFixed(2)} > SMA(${analysis.sma.toFixed(2)})`
        };
    } catch (error) {
        return false;
    }
};

async function takeBalanceSnapShot() {
    const balances = await getBalance();
    if (!balances) return;
    await BalanceSnapShot.insertMany(Object.entries(balances).map(([asset, balance]) => ({
        asset,
        free: balance.free,
        locked: balance.locked,
        timestamp: new Date()
    })));
}

async function rebalancePortfolio() {
    try {
        const balances = await getBalance();
        await takeBalanceSnapShot();
        if (!balances) return;

        const analyses = {};
        const tradeDecisions = [];

        // Step 1: Analyze all tickers and make trade decisions
        for (const symbol of tickers) {
            const analysis = await analyzeTicker(symbol);
            if (analysis) {
                analyses[symbol] = analysis;
                const trade = await getIntoAction(symbol, analysis, balances);
                if (trade) {
                    tradeDecisions.push(trade);
                }
            }
        }

        // Step 2: Merge trades by target currency
        const mergedTrades = tradeDecisions.reduce((acc, trade) => {
            const key = `${trade.baseAsset}-${trade.quoteAsset}-${trade.side}`;
            acc[key] = acc[key] || {
                symbol: trade.symbol,
                baseAsset: trade.baseAsset,
                quoteAsset: trade.quoteAsset,
                side: trade.side,
                quantity: 0,
                price: trade.price,
                fee: 0,
                reason: trade.reason,
            };
            acc[key].quantity += trade.quantity;
            acc[key].fee += trade.fee;
            return acc;
        }, {});

        // Step 3: Execute the merged trades
        let totalTrades = 0;
        let failedTrades = 0;
        for (const key in mergedTrades) {
            const trade = mergedTrades[key];
            const {
                symbol,
                quantity,
                side,
                price,
                fee,
                baseAsset,
                quoteAsset,
                reason
            } = trade;

            try {
                if (side === 'buy') {
                    await updateBalance(quoteAsset, -(quantity * price + fee));
                    await updateBalance(baseAsset, quantity);
                    console.log(`Bought ${(quantity).toFixed(PRECISION)} ${baseAsset} (${(quantity * price).toFixed(PRECISION)} ${quoteAsset}) @ ${price} (Fee: ${fee.toFixed(PRECISION)} ${quoteAsset}) (Reason: ${reason})`);
                } else if (side === 'sell') {
                    await updateBalance(baseAsset, -quantity);
                    await updateBalance(quoteAsset, quantity * price - fee);
                    console.log(`Sold ${(quantity).toFixed(PRECISION)} ${baseAsset} (${(quantity * price).toFixed(PRECISION)} ${quoteAsset}) @ ${price} (Fee: ${fee.toFixed(PRECISION)} ${quoteAsset}) (Reason: ${reason})`);
                }

                await new Trade({
                    symbol,
                    quantity,
                    side,
                    price,
                    fee,
                    reason,
                    timestamp: new Date()
                }).save();

                totalTrades++;
            } catch (e) {
                failedTrades++;
            }
        }

        console.log(`Rebalancing completed - Total Trades: ${totalTrades}, Failed Trades: ${failedTrades}`);
    } catch (error) {
        console.log('Portfolio rebalancing failed', error);
    }
}

async function getPrice(symbol) {
    try {
        const url = `${BASE_URL}/ticker/price?symbol=${symbol}`;
        const response = await axios.get(url);
        return response.data && response.data.price ? parseFloat(response.data.price) : null;
    } catch (e) {
        return null;
    }
}

async function checkCredentials() {
    try {
        await getPrice('BTCUSDT');
        return true;
    } catch (e) {
        return false;
    }
}

// --- Express API Endpoints ---
app.get('/trades', async (req, res) => {
    try {
        const { limit = 100, skip = 0, symbol, fromDate, toDate } = req.query;

        const query = {};
        if (symbol) query.symbol = symbol;
        if (fromDate || toDate) {
            query.timestamp = {};
            if (fromDate) query.timestamp.$gte = new Date(fromDate);
            if (toDate) query.timestamp.$lte = new Date(toDate);
        }

        const trades = await Trade.find(query)
            .sort({ timestamp: -1 })
            .skip(Number(skip))
            .limit(Number(limit));

        const total = await Trade.countDocuments(query);

        res.json({
            success: true,
            data: trades,
            pagination: {
                total,
                limit: Number(limit),
                skip: Number(skip)
            }
        });
    } catch (error) {
        console.error('Error fetching trades:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch trades',
            message: error.message
        });
    }
});

app.get('/balances', async (req, res) => {
    try {
        const { minBalance = 0 } = req.query;

        const balances = await Balance.find({
            $or: [
                { free: { $gt: Number(minBalance) } },
                { locked: { $gt: Number(minBalance) } }
            ]
        });

        const totalValue = await calculateTotalValue(balances);

        res.json({
            success: true,
            data: balances,
            summary: {
                totalValue,
                totalAssets: balances.length
            }
        });
    } catch (error) {
        console.error('Error fetching balances:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch balances',
            message: error.message
        });
    }
});

app.get('/balance-snapshots', async (req, res) => {
    const snapshots = await BalanceSnapShot.find().sort({ timestamp: -1 });
    res.json({
        success: true,
        data: snapshots
    });
});

app.get('/status', async (req, res) => {
    try {
        const lastTrade = await Trade.findOne().sort({ timestamp: -1 });
        const balances = await Balance.find();
        const totalValue = await calculateTotalValue(balances);

        res.json({
            success: true,
            data: {
                lastTrade,
                balances,
                totalValue,
                uptime: process.uptime(),
                timestamp: new Date()
            }
        });
    } catch (error) {
        console.error('Error fetching status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch status',
            message: error.message
        });
    }
});



async function calculateTotalValue(balances) {
    try {
        let totalValueUSDT = 0;

        for (const balance of balances) {
            const total = parseFloat(balance.free) + parseFloat(balance.locked);
            if (total <= 0) continue;

            if (balance.asset === 'USDT') {
                totalValueUSDT += total;
            } else {
                const price = await getPrice(`${balance.asset}USDT`);
                if (price) {
                    totalValueUSDT += total * price;
                }
            }
        }

        return totalValueUSDT;
    } catch (error) {
        console.error('Error calculating total value:', error);
        return null;
    }
}


// Error handling middleware
app.use((err, req, res, next) => {
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'The requested endpoint does not exist'
    });
});

// Serve HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function main() {
    try {
        await connectToMongoDB();
        const credentialsValid = await checkCredentials();

        if (!credentialsValid) {
            process.exit(1);
        }

        cron.schedule(CRON_SCHEDULE, async () => {
            console.log(`\nRebalancing started at ${new Date().toISOString()}`);
            await rebalancePortfolio();
        });
    } catch (error) {
        process.exit(1);
    }
}

main();

app.listen(PORT, () => {
    console.log(`Trading bot started on port ${PORT}`);
});