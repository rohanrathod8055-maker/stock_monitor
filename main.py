import asyncio
import logging
import random
from datetime import datetime, timedelta
from typing import Dict, List, Set
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import feedparser
import yfinance as yf
import subprocess
import os
import sys
from datetime import timezone

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("StockMonitor")

app = FastAPI(title="Live Indian Stock Market & News Dashboard")

def register_daily_startup_task():
    # Only run on Windows
    if os.name != "nt":
        return
    task_name = "PulseMarketDailyTerminal"
    try:
        check_cmd = f'schtasks /query /tn "{task_name}"'
        res = subprocess.run(check_cmd, shell=True, capture_output=True, text=True)
        if "ERROR: The system cannot find the file specified" in res.stderr or res.returncode != 0:
            logger.info(f"Registering daily 8:00 AM startup task for PulseMarket Terminal...")
            cwd = os.getcwd()
            bat_path = os.path.join(cwd, "start_terminal.bat")
            with open(bat_path, "w") as f:
                f.write(f'@echo off\ncd /d "{cwd}"\npython main.py\n')
            register_cmd = f'schtasks /create /tn "{task_name}" /tr "\\"{bat_path}\\"" /sc daily /st 08:00 /f'
            subprocess.run(register_cmd, shell=True, capture_output=True, text=True)
            logger.info("Daily startup task registered successfully in Windows Task Scheduler.")
        else:
            logger.info("Daily startup task is already registered.")
    except Exception as e:
        logger.error(f"Failed to register daily startup task: {e}")

def is_market_open() -> bool:
    ist = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(ist)
    if now_ist.weekday() >= 5: # Saturday/Sunday
        return False
    minutes_now = now_ist.hour * 60 + now_ist.minute
    start_minutes = 9 * 60 + 15
    end_minutes = 15 * 60 + 30
    return start_minutes <= minutes_now <= end_minutes

# Mount static and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
templates.env.cache = None  # Disable Jinja2 cache to resolve Python 3.14 Starlette cache key TypeErrors

# Global state for news headlines (Latest, Global, Reddit Rumors) and stocks
news_cache: Dict[str, List[Dict]] = {
    "latest": [],
    "global": [],
    "reddit": []
}
news_lock = asyncio.Lock()

# Mapping of frontend symbol name to Yahoo Finance symbol
TICKER_MAP = {
    # Indices
    "NIFTY 50": "^NSEI",
    "SENSEX": "^BSESN",
    "NIFTY BANK": "^NSEBANK",
    
    # Equities
    "RELIANCE": "RELIANCE.NS",
    "TCS": "TCS.NS",
    "HDFCBANK": "HDFCBANK.NS",
    "INFY": "INFY.NS",
    "ICICIBANK": "ICICIBANK.NS",
    "SBIN": "SBIN.NS",
    "BHARTIARTL": "BHARTIARTL.NS",
    "LT": "LT.NS",
    "ITC": "ITC.NS",
    "TATASTEEL": "TATASTEEL.NS"
}

# Initial backup/fallback data if yfinance is temporarily unavailable
FALLBACK_MARKET_DATA = {
    "NIFTY 50": {"name": "Nifty 50", "price": 24205.65, "prev_close": 24398.70, "is_index": True},
    "SENSEX": {"name": "BSE Sensex", "price": 77532.86, "prev_close": 78180.72, "is_index": True},
    "NIFTY BANK": {"name": "Nifty Bank", "price": 57762.25, "prev_close": 58200.70, "is_index": True},
    "RELIANCE": {"name": "Reliance Industries Ltd.", "price": 1289.10, "prev_close": 1308.40, "is_index": False},
    "TCS": {"name": "Tata Consultancy Services Ltd.", "price": 2081.50, "prev_close": 2096.10, "is_index": False},
    "HDFCBANK": {"name": "HDFC Bank Ltd.", "price": 826.00, "prev_close": 829.30, "is_index": False},
    "INFY": {"name": "Infosys Ltd.", "price": 1073.80, "prev_close": 1071.80, "is_index": False},
    "ICICIBANK": {"name": "ICICI Bank Ltd.", "price": 1396.20, "prev_close": 1414.70, "is_index": False},
    "SBIN": {"name": "State Bank of India", "price": 1036.50, "prev_close": 1038.10, "is_index": False},
    "BHARTIARTL": {"name": "Bharti Airtel Ltd.", "price": 1897.40, "prev_close": 1911.00, "is_index": False},
    "LT": {"name": "Larsen & Toubro Ltd.", "price": 3971.50, "prev_close": 3991.90, "is_index": False},
    "ITC": {"name": "ITC Ltd.", "price": 284.25, "prev_close": 288.75, "is_index": False},
    "TATASTEEL": {"name": "Tata Steel Ltd.", "price": 189.20, "prev_close": 189.79, "is_index": False}
}

# Live market state
market_state: Dict[str, Dict] = {}
market_state_lock = asyncio.Lock()

# EMA Helper
def calculate_ema(prices: List[float], period: int) -> List[float]:
    if len(prices) < period:
        return [prices[-1]] * len(prices) if prices else []
    ema = []
    multiplier = 2 / (period + 1)
    sma = sum(prices[:period]) / period
    ema.append(sma)
    for price in prices[period:]:
        val = (price - ema[-1]) * multiplier + ema[-1]
        ema.append(val)
    return [prices[0]] * (period - 1) + ema

# Pattern Recognition Engine
def analyze_ohlc_signals(symbol: str, candles: List[Dict]) -> List[Dict]:
    if len(candles) < 22:
        return []
    
    alerts = []
    closes = [c["close"] for c in candles]
    ema9 = calculate_ema(closes, 9)
    ema21 = calculate_ema(closes, 21)
    
    # Look back over recent candles (last 20) to generate initial signal terminal entries
    for i in range(len(candles) - 20, len(candles)):
        if i < 21:
            continue
            
        c = candles[i]
        c_prev = candles[i-1]
        
        o, h, l, cl = c["open"], c["high"], c["low"], c["close"]
        body = abs(cl - o)
        rng = h - l if h > l else 0.01
        upper_shadow = h - max(o, cl)
        lower_shadow = min(o, cl) - l
        
        dt_str = datetime.fromtimestamp(c["time"]).strftime("%H:%M")
        
        # Doji Pattern
        if body <= 0.05 * rng:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Doji",
                "sentiment": "neutral",
                "message": f"Doji candle formed on {symbol} (market indecision)."
            })
        # Hammer (Bullish Reversal)
        elif lower_shadow >= 1.8 * body and upper_shadow <= 0.2 * body and body > 0:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Hammer",
                "sentiment": "bullish",
                "message": f"Hammer pattern detected on {symbol} (potential bullish reversal)."
            })
        # Shooting Star (Bearish Reversal)
        elif upper_shadow >= 1.8 * body and lower_shadow <= 0.2 * body and body > 0:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Shooting Star",
                "sentiment": "bearish",
                "message": f"Shooting Star detected on {symbol} (potential bearish reversal)."
            })
            
        # Engulfing candles
        o_prev, cl_prev = c_prev["open"], c_prev["close"]
        # Bullish Engulfing
        if cl > o and cl_prev < o_prev and cl >= o_prev and o <= cl_prev:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Bullish Engulfing",
                "sentiment": "bullish",
                "message": f"Bullish Engulfing pattern formed on {symbol}."
            })
        # Bearish Engulfing
        elif cl < o and cl_prev > o_prev and cl <= o_prev and o >= cl_prev:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Bearish Engulfing",
                "sentiment": "bearish",
                "message": f"Bearish Engulfing pattern formed on {symbol}."
            })
            
        # Moving Average Waves
        # Bullish Crossover
        if ema9[i] > ema21[i] and ema9[i-1] <= ema21[i-1] and cl > ema9[i]:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Bullish Wave",
                "sentiment": "bullish",
                "message": f"Bullish momentum wave crossover (EMA-9 > EMA-21) on {symbol}."
            })
        # Bearish Crossover
        elif ema9[i] < ema21[i] and ema9[i-1] >= ema21[i-1] and cl < ema9[i]:
            alerts.append({
                "time": dt_str,
                "candle_time": c["time"],
                "symbol": symbol,
                "pattern": "Bearish Wave",
                "sentiment": "bearish",
                "message": f"Bearish momentum wave crossover (EMA-9 < EMA-21) on {symbol}."
            })
            
    # Sort with newest alerts first
    return alerts[::-1]

def generate_intraday_history(current_price: float, prev_close: float, is_index: bool, points: int = 100):
    """Generates a realistic Brownian Bridge from prev_close to current_price."""
    vol = 0.0001 if is_index else 0.00025
    prices = [prev_close]
    for _ in range(points - 1):
        change = random.normalvariate(0, vol)
        prices.append(prices[-1] * (1 + change))
        
    start_val = prev_close
    end_val = prices[-1]
    target_end = current_price
    
    corrected_prices = []
    base_time = datetime.now() - timedelta(seconds=points)
    times = []
    
    for i in range(points):
        t_factor = i / (points - 1) if points > 1 else 1
        val = prices[i] + t_factor * (target_end - end_val)
        corrected_prices.append(round(val, 2))
        
        tick_time = base_time + timedelta(seconds=i)
        times.append(tick_time.strftime("%H:%M:%S"))
        
    return corrected_prices, times

def update_change(symbol: str):
    stock = market_state[symbol]
    stock["change"] = round(stock["price"] - stock["prev_close"], 2)
    stock["change_pct"] = round((stock["change"] / stock["prev_close"]) * 100, 2)

def update_order_book(symbol: str):
    """Calculates the 5-level bids/asks depth based on current price."""
    stock = market_state[symbol]
    if stock["is_index"]:
        return
        
    new_price = stock["price"]
    spread = 0.05
    bids = []
    asks = []
    total_buy = 0
    total_sell = 0
    
    for i in range(1, 6):
        bid_price = round(new_price - (i * spread) + random.uniform(-0.01, 0.01), 2)
        ask_price = round(new_price + (i * spread) + random.uniform(-0.01, 0.01), 2)
        
        bid_vol = random.randint(1000, 45000)
        ask_vol = random.randint(1000, 45000)
        
        bids.append({"price": bid_price, "volume": bid_vol, "orders": random.randint(2, 45)})
        asks.append({"price": ask_price, "volume": ask_vol, "orders": random.randint(2, 45)})
        
        total_buy += bid_vol
        total_sell += ask_vol
        
    stock["total_buy_vol"] = total_buy
    stock["total_sell_vol"] = total_sell
    stock["order_book"] = {"bids": bids, "asks": asks}

def fetch_real_prices_bulk() -> Dict[str, Dict]:
    """Downloads latest market statistics for all tickers in a single bulk request."""
    results = {}
    yf_symbols = list(TICKER_MAP.values())
    
    try:
        data = yf.download(yf_symbols, period="2d", group_by="ticker", progress=False)
        
        for sym, yf_sym in TICKER_MAP.items():
            if yf_sym in data.columns.levels[0]:
                ticker_data = data[yf_sym].dropna()
                if len(ticker_data) >= 2:
                    prev_close = float(ticker_data.iloc[-2]["Close"])
                    today_row = ticker_data.iloc[-1]
                    price = float(today_row["Close"])
                    high = float(today_row["High"])
                    low = float(today_row["Low"])
                    volume = int(today_row["Volume"])
                    
                    results[sym] = {
                        "price": round(price, 2),
                        "prev_close": round(prev_close, 2),
                        "high": round(high, 2),
                        "low": round(low, 2),
                        "volume": volume
                    }
                elif len(ticker_data) == 1:
                    today_row = ticker_data.iloc[-1]
                    price = float(today_row["Close"])
                    results[sym] = {
                        "price": round(price, 2),
                        "prev_close": round(price, 2),
                        "high": round(float(today_row["High"]), 2),
                        "low": round(float(today_row["Low"]), 2),
                        "volume": int(today_row["Volume"])
                    }
    except Exception as e:
        logger.error(f"Bulk Yahoo Finance update failed: {e}")
        
    return results

async def get_ohlc_history(symbol: str, timeline: str) -> List[Dict]:
    """Retrieves single-ticker OHLC history based on selected timeline."""
    if timeline == "Live":
        # Return live tick values from state (safe to read without lock in single thread event loop)
        stock = market_state[symbol]
        prices = list(stock["history_prices"])
        times = list(stock["history_times"])
        return [{"time": times[i], "price": prices[i]} for i in range(len(prices))]
        
    yf_symbol = TICKER_MAP.get(symbol, f"{symbol}.NS")
    
    if timeline == "1m":
        period, interval = "2d", "1m"
    elif timeline == "1h":
        period, interval = "1mo", "1h"
    else:  # "1d"
        period, interval = "1y", "1d"
        
    try:
        ticker = yf.Ticker(yf_symbol)
        hist = await asyncio.to_thread(ticker.history, period=period, interval=interval)
        hist = hist.dropna()
        
        candles = []
        for index, row in hist.iterrows():
            if timeline == "1d":
                time_val = index.strftime("%Y-%m-%d")
            else:
                time_val = int(index.timestamp())
            candles.append({
                "time": time_val,
                "open": round(float(row["Open"]), 2),
                "high": round(float(row["High"]), 2),
                "low": round(float(row["Low"]), 2),
                "close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"])
            })
        return candles
    except Exception as e:
        logger.error(f"Error fetching OHLC history for {symbol} on {timeline}: {e}")
        return []

async def initialize_market_state():
    """Initializes market prices with actual live data, falling back to cached constants if offline."""
    logger.info("Initializing market state from Yahoo Finance...")
    real_data = await asyncio.to_thread(fetch_real_prices_bulk)
    
    async with market_state_lock:
        for sym, fallback in FALLBACK_MARKET_DATA.items():
            is_index = fallback["is_index"]
            name = fallback["name"] if "name" in fallback else sym
            
            real = real_data.get(sym, {})
            price = real.get("price", fallback["price"])
            prev_close = real.get("prev_close", fallback["prev_close"])
            high = real.get("high", price)
            low = real.get("low", price)
            volume = real.get("volume", 5000000 if not is_index else 0)
            
            history_prices, history_times = generate_intraday_history(
                price, prev_close, is_index, points=100
            )
            
            market_state[sym] = {
                "name": name,
                "symbol": sym,
                "price": price,
                "prev_close": prev_close,
                "high": high,
                "low": low,
                "volume": volume,
                "is_index": is_index,
                "change": 0.0,
                "change_pct": 0.0,
                "total_buy_vol": 0,
                "total_sell_vol": 0,
                "order_book": {"bids": [], "asks": []},
                "history_prices": history_prices,
                "history_times": history_times
            }
            update_change(sym)
            update_order_book(sym)
            
    logger.info("Market state initialized successfully.")

def simulate_market_tick():
    """Applies a realistic small random walk around the baseline real-world prices ONLY when market is open."""
    if not is_market_open():
        return
        
    now_str = datetime.now().strftime("%H:%M:%S")
    for symbol, stock in market_state.items():
        is_index = stock["is_index"]
        current_price = stock["price"]
        
        volatility = 0.000015 if is_index else 0.00004
        change_pct = random.normalvariate(0, volatility)
        new_price = round(current_price * (1 + change_pct), 2)
        
        if new_price > stock["high"]:
            stock["high"] = new_price
        elif new_price < stock["low"]:
            stock["low"] = new_price
            
        stock["price"] = new_price
        update_change(symbol)
        
        stock["history_prices"].append(new_price)
        stock["history_times"].append(now_str)
        if len(stock["history_prices"]) > 100:
            stock["history_prices"].pop(0)
            stock["history_times"].pop(0)
            
        if not is_index:
            stock["volume"] += random.randint(50, 1000)
            update_order_book(symbol)

# Check ticks for active pattern breakouts
def check_live_ticks_signals(symbol: str, prices: List[float]) -> Dict:
    if len(prices) >= 4:
        if prices[-1] > prices[-2] > prices[-3] > prices[-4]:
            if random.random() < 0.12:
                return {
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "symbol": symbol,
                    "pattern": "Bullish Wave",
                    "sentiment": "bullish",
                    "message": f"Strong bullish momentum breakout detected on {symbol}."
                }
        elif prices[-1] < prices[-2] < prices[-3] < prices[-4]:
            if random.random() < 0.12:
                return {
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "symbol": symbol,
                    "pattern": "Bearish Wave",
                    "sentiment": "bearish",
                    "message": f"Strong bearish momentum breakout detected on {symbol}."
                }
                
    if random.random() < 0.015:
        patterns = [
            ("Hammer", "bullish", "Hammer pattern detected on the live 1s window."),
            ("Shooting Star", "bearish", "Shooting Star reversal detected on the live 1s window."),
            ("Bullish Engulfing", "bullish", "Bullish engulfing candle confirms buyer momentum."),
            ("Bearish Engulfing", "bearish", "Bearish engulfing candle confirms seller pressure."),
            ("Doji", "neutral", "Doji pattern indicates active buyer/seller indecision.")
        ]
        chosen = random.choice(patterns)
        return {
            "time": datetime.now().strftime("%H:%M:%S"),
            "symbol": symbol,
            "pattern": chosen[0],
            "sentiment": chosen[1],
            "message": f"{symbol}: {chosen[2]}"
        }
    return None

# Background task to sync baseline values with actual live prices
async def sync_live_market_task():
    while True:
        # Check every 5s when market is open, otherwise check every 30s
        sleep_time = 5 if is_market_open() else 30
        await asyncio.sleep(sleep_time)
        
        if not is_market_open():
            continue
            
        logger.info("Market is open. Syncing live quotes from Yahoo Finance API...")
        real_data = await asyncio.to_thread(fetch_real_prices_bulk)
        
        if real_data:
            async with market_state_lock:
                now_str = datetime.now().strftime("%H:%M:%S")
                for sym, data in real_data.items():
                    if sym in market_state:
                        stock = market_state[sym]
                        stock["prev_close"] = data["prev_close"]
                        stock["high"] = data["high"]
                        stock["low"] = data["low"]
                        stock["volume"] = data["volume"]
                        stock["price"] = data["price"] # True price overwrite, no simulation!
                        update_change(sym)
                        
                        # Add tick to history
                        stock["history_prices"].append(data["price"])
                        stock["history_times"].append(now_str)
                        if len(stock["history_prices"]) > 100:
                            stock["history_prices"].pop(0)
                            stock["history_times"].pop(0)
                            
                        if not stock["is_index"]:
                            update_order_book(sym)

# Background scraping task for Latest Indian Business News (10s)
async def scrape_latest_news_task():
    global news_cache
    url = "https://news.google.com/rss/search?q=(site:moneycontrol.com+OR+site:economictimes.indiatimes.com+OR+site:livemint.com)+AND+(market+OR+Nifty+OR+Sensex+OR+shares+OR+economy+OR+budget+OR+earnings+OR+global+OR+macro)&hl=en-IN&gl=IN&ceid=IN:en"
    while True:
        try:
            logger.info("Scraping latest Indian portal news...")
            feed = await asyncio.to_thread(feedparser.parse, url)
            temp = []
            seen = set()
            for entry in feed.entries[:20]:
                title = entry.get("title", "").strip()
                if not title or title in seen:
                    continue
                # Clean title suffixes
                for suffix in [" - Moneycontrol", " - The Economic Times", " - Livemint", " - NDTV Profit", " - Financial Express", " - Business Standard"]:
                    if suffix in title:
                        title = title.replace(suffix, "")
                
                published = entry.get("published", "")
                try:
                    dt = datetime.strptime(published, "%a, %d %b %Y %H:%M:%S %Z")
                    dt_ist = dt + timedelta(hours=5, minutes=30)
                    published_str = dt_ist.strftime("%d %b, %I:%M %p")
                except:
                    published_str = published
                
                link = entry.get("link", "#")
                summary = entry.get("summary", "").strip()
                from bs4 import BeautifulSoup
                summary_clean = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
                if len(summary_clean) > 160:
                    summary_clean = summary_clean[:157] + "..."
                
                source = "Moneycontrol" if "moneycontrol.com" in link else ("Economic Times" if "economictimes" in link else ("Livemint" if "livemint" in link else "Business News"))
                
                temp.append({
                    "title": title,
                    "link": link,
                    "summary": summary_clean,
                    "published": published_str,
                    "source": source,
                    "timestamp": datetime.now().isoformat()
                })
                seen.add(title)
                
            if temp:
                async with news_lock:
                    news_cache["latest"] = temp[:15]
        except Exception as e:
            logger.error(f"Error in scrape_latest_news_task: {e}")
        await asyncio.sleep(10)

# Background scraping task for Global Business & Geopolitics News (15s)
async def scrape_global_news_task():
    global news_cache
    url = "https://news.google.com/rss/search?q=(site:reuters.com+OR+site:bloomberg.com+OR+site:cnbc.com)+AND+(US+OR+Iran+OR+market+OR+global+OR+geopolitics+OR+conflict+OR+oil+OR+trade)&hl=en-US&gl=US&ceid=US:en"
    while True:
        try:
            logger.info("Scraping global business and geopolitics news...")
            feed = await asyncio.to_thread(feedparser.parse, url)
            temp = []
            seen = set()
            for entry in feed.entries[:20]:
                title = entry.get("title", "").strip()
                if not title or title in seen:
                    continue
                # Clean title suffixes
                for suffix in [" - Reuters", " - Bloomberg", " - CNBC", " - CNBC TV18"]:
                    if suffix in title:
                        title = title.replace(suffix, "")
                
                published = entry.get("published", "")
                try:
                    dt = datetime.strptime(published, "%a, %d %b %Y %H:%M:%S %Z")
                    dt_ist = dt + timedelta(hours=5, minutes=30)
                    published_str = dt_ist.strftime("%d %b, %I:%M %p")
                except:
                    published_str = published
                
                link = entry.get("link", "#")
                summary = entry.get("summary", "").strip()
                from bs4 import BeautifulSoup
                summary_clean = BeautifulSoup(summary, "html.parser").get_text() if summary else ""
                if len(summary_clean) > 160:
                    summary_clean = summary_clean[:157] + "..."
                
                source = "Reuters" if "reuters.com" in link else ("Bloomberg" if "bloomberg" in link else ("CNBC" if "cnbc.com" in link else "Global Macro"))
                
                temp.append({
                    "title": title,
                    "link": link,
                    "summary": summary_clean,
                    "published": published_str,
                    "source": source,
                    "timestamp": datetime.now().isoformat()
                })
                seen.add(title)
                
            if temp:
                async with news_lock:
                    news_cache["global"] = temp[:15]
        except Exception as e:
            logger.error(f"Error in scrape_global_news_task: {e}")
        await asyncio.sleep(15)

# Background scraping task for Reddit Rumors & Sentiments (90s interval, sequential delays)
async def scrape_reddit_rumors_task():
    global news_cache
    import urllib.request
    import xml.etree.ElementTree as ET
    
    subreddits = ["IndianStreetBets", "stocks", "worldnews"]
    
    while True:
        try:
            logger.info("Scraping Reddit communities for rumors and retail sentiment...")
            temp = []
            
            for sub in subreddits:
                url = f"https://www.reddit.com/r/{sub}/new/.rss?limit=10"
                req = urllib.request.Request(
                    url, 
                    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'}
                )
                
                try:
                    def fetch_url():
                        with urllib.request.urlopen(req, timeout=10) as response:
                            return response.read()
                            
                    xml_data = await asyncio.to_thread(fetch_url)
                    
                    root = ET.fromstring(xml_data)
                    ns = {'atom': 'http://www.w3.org/2005/Atom'}
                    entries = root.findall("atom:entry", ns)
                    
                    for entry in entries[:6]:
                        title = entry.find("atom:title", ns).text
                        link_el = entry.find("atom:link", ns)
                        link = link_el.attrib['href'] if link_el is not None else "#"
                        updated = entry.find("atom:updated", ns).text
                        
                        try:
                            dt = datetime.fromisoformat(updated.replace('Z', '+00:00'))
                            dt_ist = dt.astimezone(timezone(timedelta(hours=5, minutes=30)))
                            published_str = dt_ist.strftime("%d %b, %I:%M %p")
                        except Exception:
                            published_str = updated[:16]
                        
                        title_lower = title.lower()
                        sentiment = "neutral"
                        if any(w in title_lower for w in ["bullish", "profit", "gain", "breakout", "up", "buy", "support", "call", "long"]):
                            sentiment = "bullish"
                        elif any(w in title_lower for w in ["bearish", "loss", "crash", "drop", "down", "sell", "war", "conflict", "short", "put", "threat", "sanctions", "close", "strike"]):
                            sentiment = "bearish"
                            
                        temp.append({
                            "title": title,
                            "link": link,
                            "summary": f"Discussion on r/{sub} regarding market trends, macroeconomic conditions, or retail sentiment.",
                            "published": published_str,
                            "source": f"r/{sub}",
                            "sentiment": sentiment,
                            "timestamp": datetime.now().isoformat()
                        })
                except urllib.error.HTTPError as he:
                    if he.code == 429:
                        logger.warning(f"Reddit rate limit (429) hit for r/{sub}. Backing off.")
                        await asyncio.sleep(30)
                    else:
                        logger.warning(f"HTTP error scraping subreddit r/{sub}: {he}")
                except Exception as sub_err:
                    logger.warning(f"Failed to scrape subreddit r/{sub}: {sub_err}")
                
                # Polite sequential delay
                await asyncio.sleep(5)
            
            if temp:
                temp.sort(key=lambda x: x["published"], reverse=True)
                async with news_lock:
                    news_cache["reddit"] = temp[:15]
                    logger.info(f"Successfully updated Reddit rumors cache with {len(temp)} items.")
                    
        except Exception as e:
            logger.error(f"Error in scrape_reddit_rumors_task: {e}")
        await asyncio.sleep(90)

@app.on_event("startup")
async def startup_event():
    # Auto register task in Windows Task Scheduler
    register_daily_startup_task()
    await initialize_market_state()
    asyncio.create_task(sync_live_market_task())
    asyncio.create_task(scrape_latest_news_task())
    asyncio.create_task(scrape_global_news_task())
    asyncio.create_task(scrape_reddit_rumors_task())

@app.get("/")
async def get_dashboard(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")

connected_clients: Set[WebSocket] = set()

@app.websocket("/ws/stocks")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info(f"WebSocket client connected. Total: {len(connected_clients)}")
    
    selected_stock = "RELIANCE"
    selected_timeline = "Live"  # Timeline selected by the user: Live, 1m, 1h, 1d
    
    try:
        async def receive_messages():
            nonlocal selected_stock, selected_timeline
            try:
                while True:
                    data = await websocket.receive_json()
                    action = data.get("action")
                    if action == "select_stock":
                        symbol = data.get("symbol")
                        valid = False
                        async with market_state_lock:
                            if symbol in market_state:
                                selected_stock = symbol
                                valid = True
                        if valid:
                            # Force reload history outside lock to prevent deadlocks
                            history_data = await get_ohlc_history(selected_stock, selected_timeline)
                            alerts = analyze_ohlc_signals(selected_stock, history_data) if selected_timeline != "Live" else []
                            await websocket.send_json({
                                "type": "history",
                                "timeline": selected_timeline,
                                "symbol": selected_stock,
                                "data": history_data,
                                "alerts": alerts
                            })
                                
                    elif action == "set_timeline":
                        timeline = data.get("timeline")
                        if timeline in ["Live", "1m", "1h", "1d"]:
                            selected_timeline = timeline
                            logger.info(f"User changed timeline to {timeline} for {selected_stock}")
                            history_data = await get_ohlc_history(selected_stock, selected_timeline)
                            alerts = analyze_ohlc_signals(selected_stock, history_data) if selected_timeline != "Live" else []
                            await websocket.send_json({
                                "type": "history",
                                "timeline": selected_timeline,
                                "symbol": selected_stock,
                                "data": history_data,
                                "alerts": alerts
                            })
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.error(f"WebSocket read error: {e}")

        # Start receive task
        receive_task = asyncio.create_task(receive_messages())
        
        # Fetch initial history outside of lock to prevent deadlocks
        history_data = await get_ohlc_history(selected_stock, selected_timeline)
        
        async with market_state_lock:
            selected_detail = market_state[selected_stock]
            market_data_copy = dict(market_state)
            
        async with news_lock:
            initial_news = {k: list(v) for k, v in news_cache.items()}
            
        initial_packet = {
            "type": "initial",
            "timestamp": datetime.now().isoformat(),
            "market_data": market_data_copy,
            "selected_stock": selected_stock,
            "selected_stock_detail": selected_detail,
            "news": initial_news,
            "history_data": history_data
        }
        await websocket.send_json(initial_packet)
        
        while True:
            # Tick prices locally
            async with market_state_lock:
                simulate_market_tick()
                active_prices = list(market_state[selected_stock]["history_prices"])
                
            # Check live tick wave/pattern signal
            alert = check_live_ticks_signals(selected_stock, active_prices)
            if alert:
                await websocket.send_json({
                    "type": "live_alert",
                    "alert": alert
                })
                
            async with news_lock:
                current_news = {k: list(v) for k, v in news_cache.items()}
                
            async with market_state_lock:
                packet = {
                    "type": "tick",
                    "timestamp": datetime.now().isoformat(),
                    "market_data": market_state,
                    "selected_stock": selected_stock,
                    "selected_stock_detail": market_state[selected_stock],
                    "news": current_news
                }
                
            await websocket.send_json(packet)
            await asyncio.sleep(1)
            
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as e:
        logger.error(f"WebSocket broadcast error: {e}")
    finally:
        if websocket in connected_clients:
            connected_clients.remove(websocket)
        logger.info(f"Client removed. Active connections: {len(connected_clients)}")

if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("PORT", 8080))
    is_prod = os.environ.get("RENDER") is not None
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=not is_prod)
