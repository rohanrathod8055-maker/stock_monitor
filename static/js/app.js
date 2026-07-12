// Live Trading Terminal - Frontend Controller
let ws = null;
let chart = null;
let candlestickSeries = null;
let volumeSeries = null;

let currentSymbol = "RELIANCE";
let activeTimeline = "Live"; // Default timeline
let selectedMarkerTime = null; // Clicked time for custom markers

// Live Candlestick Aggregator State (For 5-second grouped live candles)
let lastCandleTime = 0;
let liveCandleOpen = null;
let liveCandleHigh = null;
let liveCandleLow = null;
let liveCandleClose = null;
let liveCandleVolume = 0;

// Track historical boundaries to update the last completed candle with incoming ticks
let lastHistoryCandle = null;

// News Feed category cache and active state
let activeNewsTab = "latest";
let newsCacheData = { latest: [], global: [], reddit: [] };

// Workspace active tab
let activeWorkspaceTab = "chart";

// Global market data cache
let marketData = null;

// Clock in header
function updateClock() {
    const clockEl = document.getElementById('live-clock');
    if (clockEl) {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString('en-IN', { hour12: false });
    }
}
setInterval(updateClock, 1000);
updateClock();

// Initialize TradingView Lightweight Chart
function initTradingViewChart() {
    const container = document.getElementById('chart-wrap');
    if (!container) return;
    
    // Clear any existing elements
    container.innerHTML = "";
    
    const chartOptions = {
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#d1d5db',
            fontSize: 11,
            fontFamily: 'Plus Jakarta Sans',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.015)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.015)' },
        },
        crosshair: {
            mode: 1, // Normal mode
            vertLine: { color: 'rgba(99, 102, 241, 0.4)', width: 1, style: 3 },
            horzLine: { color: 'rgba(99, 102, 241, 0.4)', width: 1, style: 3 },
        },
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.06)',
            scaleMargins: {
                top: 0.1,
                bottom: 0.25,
            },
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.06)',
            timeVisible: true,
            secondsVisible: true,
        },
        handleScale: {
            mouseWheel: true,
            pinch: true,
            axisPressedMouseMove: {
                time: true,
                price: true,
            },
        },
        handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: true,
        },
    };
    
    chart = LightweightCharts.createChart(container, chartOptions);
    
    // Add candlestick series
    candlestickSeries = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#f43f5e',
        borderDownColor: '#f43f5e',
        borderUpColor: '#10b981',
        wickDownColor: '#f43f5e',
        wickUpColor: '#10b981',
    });
    
    // Add volume histogram series
    volumeSeries = chart.addHistogramSeries({
        color: 'rgba(59, 130, 246, 0.35)',
        priceFormat: { type: 'volume' },
        priceScaleId: '', // Overlay style
    });
    
    // Constrain volume scale to bottom 25% of chart
    volumeSeries.priceScale().applyOptions({
        scaleMargins: {
            top: 0.8,
            bottom: 0,
        },
    });
    
    // Subscribe to chart clicks to set custom marker location
    chart.subscribeClick((param) => {
        if (!param || !param.time) return;
        selectedMarkerTime = param.time;
        
        const label = document.getElementById('selected-time-label');
        if (label) {
            if (typeof param.time === 'number') {
                const date = new Date(param.time * 1000);
                label.textContent = `Target Candle: ${date.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}`;
            } else {
                label.textContent = `Target Candle: ${param.time}`;
            }
            label.style.color = "var(--color-accent)";
        }
    });
    
    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const { width, height } = entry.contentRect;
            if (chart) {
                chart.resize(width, height);
                chart.timeScale().fitContent();
            }
        }
    });
    resizeObserver.observe(container);
}

// Timeline toggle handler
function changeTimeline(timeline) {
    if (timeline === activeTimeline) return;
    
    activeTimeline = timeline;
    
    // Highlight timeline button
    document.querySelectorAll('.timeline-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`tl-${timeline}`);
    if (activeBtn) activeBtn.classList.add('active');
    
    // Request timeline data from WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: "set_timeline",
            timeline: timeline
        }));
    }
    
    // Reset live candlestick accumulator
    lastCandleTime = 0;
    liveCandleOpen = null;
    lastHistoryCandle = null;
}

// Initialize WebSocket Connection
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/stocks`;
    
    const dot = document.getElementById('connection-dot');
    const statusText = document.getElementById('connection-status');
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        dot.className = 'pulse-dot online';
        statusText.textContent = 'Live';
        console.log("WebSocket connected.");
        
        // If reconnecting, sync timeline
        ws.send(JSON.stringify({
            action: "set_timeline",
            timeline: activeTimeline
        }));
    };
    
    ws.onclose = () => {
        dot.className = 'pulse-dot';
        statusText.textContent = 'Reconnecting...';
        setTimeout(connectWebSocket, 2000);
    };
    
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === "history") {
                handleHistoryData(data);
            } else if (data.type === "live_alert") {
                handleLiveAlert(data.alert);
            } else if (data.type === "ai_advisory") {
                handleAiAdvisory(data);
            } else {
                handleMarketUpdate(data);
            }
        } catch (e) {
            console.error("Message parsing error:", e);
        }
    };
}

// Parse history packets from yfinance
function handleHistoryData(packet) {
    if (packet.symbol !== currentSymbol || packet.timeline !== activeTimeline) return;
    
    const ohlcData = packet.data;
    const chartData = [];
    const volData = [];
    
    if (activeTimeline === "Live") {
        // Let's transform live history ticks into simulated 5-second candles to keep candlesticks consistent!
        const grouped = groupTicksIntoCandles(ohlcData);
        grouped.candles.forEach(c => chartData.push(c));
        grouped.volume.forEach(v => volData.push(v));
    } else {
        // Draw direct OHLC candles
        ohlcData.forEach(candle => {
            chartData.push({
                time: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close
            });
            volData.push({
                time: candle.time,
                value: candle.volume,
                color: candle.close >= candle.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'
            });
        });
    }
    
    if (candlestickSeries && volumeSeries) {
        candlestickSeries.setData(chartData);
        volumeSeries.setData(volData);
        
        // Track the last history candle so ticks can update it inline
        if (chartData.length > 0) {
            lastHistoryCandle = chartData[chartData.length - 1];
        }
        
        chart.timeScale().fitContent();
        
        // Combine automated alert markers with user markers
        const autoMarkers = (packet.alerts || []).map(alert => {
            if (!alert.candle_time) return null;
            return {
                time: alert.candle_time,
                position: alert.sentiment === 'bullish' ? 'belowBar' : (alert.sentiment === 'bearish' ? 'aboveBar' : 'inBar'),
                color: alert.sentiment === 'bullish' ? '#10b981' : (alert.sentiment === 'bearish' ? '#f43f5e' : '#3b82f6'),
                shape: alert.sentiment === 'bullish' ? 'arrowUp' : (alert.sentiment === 'bearish' ? 'arrowDown' : 'circle'),
                text: alert.pattern
            };
        }).filter(Boolean);
        
        const userMarkers = customMarkers[currentSymbol] || [];
        const allMarkers = [...autoMarkers, ...userMarkers];
        
        // Sort chronologically (Lightweight Charts strict requirement)
        allMarkers.sort((a, b) => {
            const valA = typeof a.time === 'string' ? new Date(a.time).getTime() : a.time * 1000;
            const valB = typeof b.time === 'string' ? new Date(b.time).getTime() : b.time * 1000;
            return valA - valB;
        });
        
        if (candlestickSeries) {
            candlestickSeries.setMarkers(allMarkers);
        }
        
        // Update badge count
        const badge = document.getElementById('marker-badge');
        if (badge) {
            const userCount = userMarkers.length;
            if (userCount > 0) {
                badge.textContent = userCount;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }
    }
    
    // Render historical signals in Alerts terminal
    renderHistoricalAlerts(packet.alerts);
}

// Convert live history prices (seconds) into 5s candles for initial load
function groupTicksIntoCandles(ticks) {
    const candles = [];
    const volume = [];
    
    if (ticks.length === 0) return { candles, volume };
    
    let currentGroupTime = null;
    let open = null, high = null, low = null, close = null;
    
    ticks.forEach((tick, idx) => {
        // Parse time string e.g. "12:45:10" into unix equivalent for scale spacing
        const timeVal = parseTimeString(tick.time);
        const groupedTime = Math.floor(timeVal / 5) * 5;
        
        if (currentGroupTime === null || groupedTime !== currentGroupTime) {
            if (currentGroupTime !== null) {
                candles.push({ time: currentGroupTime, open, high, low, close });
                volume.push({ time: currentGroupTime, value: 5000, color: close >= open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)' });
            }
            currentGroupTime = groupedTime;
            open = tick.price;
            high = tick.price;
            low = tick.price;
            close = tick.price;
        } else {
            high = Math.max(high, tick.price);
            low = Math.min(low, tick.price);
            close = tick.price;
        }
    });
    
    if (currentGroupTime !== null) {
        candles.push({ time: currentGroupTime, open, high, low, close });
        volume.push({ time: currentGroupTime, value: 5000, color: close >= open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)' });
    }
    
    return { candles, volume };
}

// Parse "HH:MM:SS" into numeric seconds since start of day
function parseTimeString(timeStr) {
    try {
        const parts = timeStr.split(':');
        const now = new Date();
        now.setHours(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]), 0);
        return Math.floor(now.getTime() / 1000);
    } catch (e) {
        return Math.floor(Date.now() / 1000);
    }
}

// Live tick handlers (1-second intervals)
function handleMarketUpdate(data) {
    marketData = data.market_data;
    const selectedStock = data.selected_stock;
    const stockDetail = data.selected_stock_detail;
    const news = data.news;
    
    currentSymbol = selectedStock;
    
    renderTickerTape(marketData);
    renderIndices(marketData);
    renderWatchlist(marketData, currentSymbol);
    renderActiveStockDetail(marketData[currentSymbol] || stockDetail);
    renderMarketDepth(marketData[currentSymbol] || stockDetail);
    
    if (news) {
        newsCacheData = news;
        renderNews(newsCacheData[activeNewsTab] || []);
    }
    
    if (activeWorkspaceTab === "fo") {
        renderOptionsChain();
    }
    
    // Update Candlestick Chart in Real-Time
    const tickPrice = marketData[currentSymbol].price;
    const tickVol = marketData[currentSymbol].volume;
    updateLiveChartTick(tickPrice, tickVol);
}

// Updates the TradingView candlestick structure dynamically with 1s ticks
function updateLiveChartTick(price, volume) {
    if (!candlestickSeries) return;
    if (activeTimeline !== "Live") return; // Prevent live ticks from corrupting historical charts
    
    // Stop chart updates/ticking entirely if market is closed
    if (!isMarketOpen()) return;
    
    const nowSec = Math.floor(Date.now() / 1000);
    
    if (activeTimeline === "Live") {
        // Group ticks into 5-second candles
        const groupedTime = Math.floor(nowSec / 5) * 5;
        
        if (lastCandleTime === 0 || groupedTime !== lastCandleTime) {
            lastCandleTime = groupedTime;
            liveCandleOpen = price;
            liveCandleHigh = price;
            liveCandleLow = price;
            liveCandleClose = price;
            liveCandleVolume = 2000;
        } else {
            liveCandleHigh = Math.max(liveCandleHigh, price);
            liveCandleLow = Math.min(liveCandleLow, price);
            liveCandleClose = price;
            liveCandleVolume += 300;
        }
        
        candlestickSeries.update({
            time: lastCandleTime,
            open: liveCandleOpen,
            high: liveCandleHigh,
            low: liveCandleLow,
            close: liveCandleClose
        });
        
        volumeSeries.update({
            time: lastCandleTime,
            value: liveCandleVolume,
            color: liveCandleClose >= liveCandleOpen ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'
        });
    } else {
        // Update the last history candle inline
        if (lastHistoryCandle) {
            const timeVal = lastHistoryCandle.time;
            const openVal = lastHistoryCandle.open;
            
            // Adjust high/low bounds of the active candle
            const highVal = Math.max(lastHistoryCandle.high || openVal, price);
            const lowVal = Math.min(lastHistoryCandle.low || openVal, price);
            
            const updatedCandle = {
                time: timeVal,
                open: openVal,
                high: highVal,
                low: lowVal,
                close: price
            };
            
            candlestickSeries.update(updatedCandle);
            
            volumeSeries.update({
                time: timeVal,
                value: volume,
                color: price >= openVal ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'
            });
        }
    }
}

// Render watchlist elements
function renderWatchlist(marketData, selectedSymbol) {
    const tbody = document.getElementById('watchlist-body');
    if (!tbody) return;
    
    const symbols = Object.keys(marketData).filter(s => !marketData[s].is_index).sort();
    
    symbols.forEach(symbol => {
        const data = marketData[symbol];
        let row = document.getElementById(`wl-row-${symbol}`);
        
        const isSelected = symbol === selectedSymbol;
        const changeClass = data.change_pct >= 0 ? 'gain' : 'loss';
        const sign = data.change_pct >= 0 ? '+' : '';
        
        if (!row) {
            row = document.createElement('tr');
            row.id = `wl-row-${symbol}`;
            row.className = `watchlist-row ${isSelected ? 'selected' : ''}`;
            row.onclick = () => selectStock(symbol);
            
            row.innerHTML = `
                <td class="watchlist-cell" style="padding-left: 0.5rem;">
                    <span class="watchlist-symbol">${symbol}</span>
                    <span class="watchlist-name">${data.name}</span>
                </td>
                <td class="watchlist-cell watchlist-price" id="wl-price-${symbol}">₹${data.price.toFixed(2)}</td>
                <td class="watchlist-cell watchlist-pct ${changeClass}" id="wl-pct-${symbol}">${sign}${data.change_pct.toFixed(2)}%</td>
            `;
            tbody.appendChild(row);
        } else {
            const priceEl = document.getElementById(`wl-price-${symbol}`);
            const pctEl = document.getElementById(`wl-pct-${symbol}`);
            
            const oldPrice = parseFloat(priceEl.textContent.replace('₹', ''));
            const newPrice = data.price;
            
            priceEl.textContent = `₹${newPrice.toFixed(2)}`;
            pctEl.textContent = `${sign}${data.change_pct.toFixed(2)}%`;
            pctEl.className = `watchlist-cell watchlist-pct ${changeClass}`;
            
            row.className = `watchlist-row ${isSelected ? 'selected' : ''}`;
            
            if (oldPrice && oldPrice !== newPrice) {
                const tickClass = newPrice > oldPrice ? 'tick-up' : 'tick-down';
                priceEl.classList.remove('tick-up', 'tick-down');
                void priceEl.offsetWidth; // Restart anim
                priceEl.classList.add(tickClass);
            }
        }
    });
}

// Request backend to change active stock view
function selectStock(symbol) {
    if (symbol === currentSymbol) return;
    
    currentSymbol = symbol;
    
    document.querySelectorAll('.watchlist-row').forEach(row => {
        row.classList.remove('selected');
    });
    const selectedRow = document.getElementById(`wl-row-${symbol}`);
    if (selectedRow) selectedRow.classList.add('selected');
    
    // Request chart history switch
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            action: "select_stock",
            symbol: symbol
        }));
    }
}

// Render top indices (Nifty, Sensex, Bank)
function renderIndices(marketData) {
    const indexSymbols = ["NIFTY 50", "SENSEX", "NIFTY BANK"];
    
    indexSymbols.forEach(sym => {
        const data = marketData[sym];
        if (!data) return;
        
        const idSuffix = sym.replace(' ', '-');
        const priceEl = document.getElementById(`idx-price-${idSuffix}`);
        const changeEl = document.getElementById(`idx-change-${idSuffix}`);
        const cardEl = document.getElementById(`card-${idSuffix}`);
        
        if (priceEl && changeEl) {
            const oldPrice = parseFloat(priceEl.textContent.replace(/,/g, ''));
            const newPrice = data.price;
            
            priceEl.textContent = newPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            
            const sign = data.change >= 0 ? '+' : '';
            changeEl.innerHTML = `<span>${sign}${data.change.toFixed(2)}</span> <span>(${sign}${data.change_pct.toFixed(2)}%)</span>`;
            
            const changeClass = data.change_pct >= 0 ? 'gain' : 'loss';
            changeEl.className = `index-change-wrap ${changeClass}`;
            
            if (oldPrice && oldPrice !== newPrice) {
                const tickClass = newPrice > oldPrice ? 'tick-up' : 'tick-down';
                cardEl.classList.remove('tick-up', 'tick-down');
                void cardEl.offsetWidth;
                cardEl.classList.add(tickClass);
            }
        }
    });
}

// Render active details
function renderActiveStockDetail(stockDetail) {
    const symbol = stockDetail.symbol;
    const sign = stockDetail.change_pct >= 0 ? '+' : '';
    const changeClass = stockDetail.change_pct >= 0 ? 'gain' : 'loss';
    
    document.getElementById('detail-name').textContent = stockDetail.name;
    document.getElementById('detail-symbol').textContent = symbol;
    
    const priceEl = document.getElementById('detail-price');
    const oldPrice = parseFloat(priceEl.textContent);
    priceEl.textContent = stockDetail.price.toFixed(2);
    
    if (oldPrice && oldPrice !== stockDetail.price) {
        const tickClass = stockDetail.price > oldPrice ? 'tick-up' : 'tick-down';
        priceEl.className = `selected-price ${tickClass}`;
    }
    
    const changeWrap = document.getElementById('detail-change-wrap');
    document.getElementById('detail-change').textContent = `${sign}${stockDetail.change.toFixed(2)}`;
    document.getElementById('detail-change-pct').textContent = `(${sign}${stockDetail.change_pct.toFixed(2)}%)`;
    changeWrap.className = `index-change-wrap ${changeClass}`;
    
    document.getElementById('detail-high').textContent = stockDetail.high.toFixed(2);
    document.getElementById('detail-low').textContent = stockDetail.low.toFixed(2);
    document.getElementById('detail-vol').textContent = stockDetail.volume.toLocaleString('en-IN');
}

// Render order book Market Depth
function renderMarketDepth(stockDetail) {
    if (!isMarketOpen()) {
        // Display Market Closed status in order book
        document.getElementById('buyer-ratio-bar').style.width = `50%`;
        document.getElementById('buyer-ratio-label').textContent = `Buyers: 50%`;
        document.getElementById('seller-ratio-label').textContent = `Sellers: 50%`;
        
        document.getElementById('total-buy-qty').textContent = "0";
        document.getElementById('total-sell-qty').textContent = "0";
        
        const tbody = document.getElementById('depth-table-body');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.85rem;">Market Closed (LEVEL 2 Real Depth Closed)</td></tr>`;
        }
        tickTradeLog(stockDetail);
        return;
    }
    
    const book = stockDetail.order_book;
    const totalBuy = stockDetail.total_buy_vol;
    const totalSell = stockDetail.total_sell_vol;
    
    const totalDepth = totalBuy + totalSell;
    const buyerRatio = totalDepth > 0 ? (totalBuy / totalDepth) * 100 : 50;
    const sellerRatio = 100 - buyerRatio;
    
    document.getElementById('buyer-ratio-bar').style.width = `${buyerRatio}%`;
    document.getElementById('buyer-ratio-label').textContent = `Buyers: ${buyerRatio.toFixed(1)}%`;
    document.getElementById('seller-ratio-label').textContent = `Sellers: ${sellerRatio.toFixed(1)}%`;
    
    document.getElementById('total-buy-qty').textContent = totalBuy.toLocaleString('en-IN');
    document.getElementById('total-sell-qty').textContent = totalSell.toLocaleString('en-IN');
    
    const tbody = document.getElementById('depth-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = "";
    
    let maxVol = 1;
    for (let i = 0; i < 5; i++) {
        if (book.bids[i] && book.bids[i].volume > maxVol) maxVol = book.bids[i].volume;
        if (book.asks[i] && book.asks[i].volume > maxVol) maxVol = book.asks[i].volume;
    }
    
    for (let i = 0; i < 5; i++) {
        const bid = book.bids[i] || { price: 0.0, volume: 0, orders: 0 };
        const ask = book.asks[i] || { price: 0.0, volume: 0, orders: 0 };
        
        const bidPercent = maxVol > 0 ? (bid.volume / maxVol) * 100 : 0;
        const askPercent = maxVol > 0 ? (ask.volume / maxVol) * 100 : 0;
        
        const tr = document.createElement('tr');
        tr.className = 'depth-row';
        tr.innerHTML = `
            <td class="depth-cell bid">
                <span class="depth-bg" style="width: ${bidPercent}%; left: 0; right: auto;"></span>
                <span class="depth-price">${bid.price > 0 ? bid.price.toFixed(2) : '--'}</span>
            </td>
            <td class="depth-cell depth-volume" style="padding-right: 0.5rem; text-align: right;">${bid.volume > 0 ? bid.volume.toLocaleString('en-IN') : '--'}</td>
            <td class="depth-cell ask">
                <span class="depth-bg" style="width: ${askPercent}%; right: 0; left: auto;"></span>
                <span class="depth-price">${ask.price > 0 ? ask.price.toFixed(2) : '--'}</span>
            </td>
            <td class="depth-cell depth-volume" style="text-align: right;">${ask.volume > 0 ? ask.volume.toLocaleString('en-IN') : '--'}</td>
        `;
        tbody.appendChild(tr);
    }
    
    tickTradeLog(stockDetail);
}

// Generate scrolling mock trade execution logs
let recentTrades = [];
function tickTradeLog(stockDetail) {
    const listBody = document.getElementById('trades-list-body');
    if (!listBody) return;
    
    if (!isMarketOpen()) {
        listBody.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1.2rem; font-size: 0.75rem;">Market Closed - No Active Trades</div>`;
        return;
    }
    
    const ticksCount = Math.floor(Math.random() * 2) + 1;
    const now = new Date().toLocaleTimeString('en-IN', { hour12: false });
    
    for (let i = 0; i < ticksCount; i++) {
        const priceOffset = (Math.random() - 0.5) * 0.1;
        const tradePrice = stockDetail.price + priceOffset;
        const tradeQty = Math.floor(Math.random() * 150) + 5;
        const isBuyerTrade = Math.random() > 0.49;
        
        recentTrades.unshift({
            time: now,
            price: tradePrice.toFixed(2),
            qty: tradeQty,
            type: isBuyerTrade ? 'BUY' : 'SELL'
        });
    }
    
    if (recentTrades.length > 15) {
        recentTrades = recentTrades.slice(0, 15);
    }
    
    listBody.innerHTML = "";
    recentTrades.forEach(trade => {
        const colorClass = trade.type === 'BUY' ? 'gain' : 'loss';
        const div = document.createElement('div');
        div.className = 'trade-item';
        div.innerHTML = `
            <span class="trade-time">${trade.time}</span>
            <span class="trade-price ${colorClass}" style="font-weight:700;">₹${trade.price}</span>
            <span class="trade-vol">${trade.qty} <span class="${colorClass}" style="font-size:0.6rem; font-weight:bold;">${trade.type}</span></span>
        `;
        listBody.appendChild(div);
    });
}

// News Feed renderer
let currentNewsHash = "";
function renderNews(newsList) {
    const container = document.getElementById('news-cards-container');
    if (!container) return;
    
    const newsHash = newsList.map(n => n.title).join('|');
    if (newsHash === currentNewsHash) return;
    currentNewsHash = newsHash;
    
    if (newsList.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); margin-top: 2rem; font-size: 0.85rem;">
                No articles available in this category.
            </div>
        `;
        return;
    }
    
    container.innerHTML = "";
    newsList.forEach(item => {
        const card = document.createElement('div');
        card.className = 'news-card';
        
        // Render custom sentiment badge for Reddit posts
        let badgeHtml = "";
        if (item.sentiment) {
            const label = item.sentiment.toUpperCase();
            const color = item.sentiment === 'bullish' ? 'var(--color-gain)' : (item.sentiment === 'bearish' ? 'var(--color-loss)' : 'var(--color-buyer)');
            const bg = item.sentiment === 'bullish' ? 'rgba(16, 185, 129, 0.1)' : (item.sentiment === 'bearish' ? 'rgba(244, 63, 94, 0.1)' : 'rgba(14, 165, 233, 0.1)');
            badgeHtml = `<span style="font-size: 0.65rem; font-weight: 700; color: ${color}; background: ${bg}; padding: 0.15rem 0.4rem; border-radius: 4px; border: 1px solid ${color}33;">${label}</span>`;
        }
        
        card.innerHTML = `
            <div class="news-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <span class="news-source" style="font-weight: 700; color: #fff; font-size: 0.75rem;">${item.source}</span>
                    ${badgeHtml}
                </div>
                <span class="news-time">${item.published}</span>
            </div>
            <a href="${item.link}" target="_blank" class="news-title" style="display: block; font-size: 0.85rem; font-weight: 700; margin-bottom: 0.35rem; text-decoration: none; color: #fff; line-height: 1.3; transition: color 0.2s;" onmouseover="this.style.color='var(--color-accent)'" onmouseout="this.style.color='#fff'">${item.title}</a>
            <p class="news-desc" style="font-size: 0.75rem; color: var(--text-secondary); margin: 0; line-height: 1.4;">${item.summary}</p>
        `;
        container.appendChild(card);
    });
    
    const newsHeader = document.getElementById('news-refresh-indicator');
    if (newsHeader) {
        newsHeader.textContent = "Refreshed!";
        newsHeader.style.borderColor = "var(--color-gain)";
        newsHeader.style.color = "var(--color-gain)";
        
        setTimeout(() => {
            newsHeader.textContent = "30s Sync";
            newsHeader.style.borderColor = "var(--border-color)";
            newsHeader.style.color = "var(--text-secondary)";
        }, 3000);
    }
}

// Ticker Tape renderer
function renderTickerTape(marketData) {
    const tapeContainer = document.getElementById('ticker-tape');
    if (!tapeContainer) return;
    
    if (tapeContainer.children.length === 0) {
        let itemsHtml = "";
        for (const [symbol, data] of Object.entries(marketData)) {
            if (data.is_index) continue;
            
            itemsHtml += `
                <div class="ticker-item" id="ticker-${symbol}" onclick="selectStock('${symbol}')">
                    <span class="ticker-symbol">${symbol}</span>
                    <span class="ticker-price" id="ticker-price-${symbol}">₹${data.price.toFixed(2)}</span>
                    <span class="ticker-change" id="ticker-change-${symbol}">+0.00%</span>
                </div>
            `;
        }
        tapeContainer.innerHTML = itemsHtml + itemsHtml;
    }
    
    for (const [symbol, data] of Object.entries(marketData)) {
        if (data.is_index) continue;
        
        const priceEls = document.querySelectorAll(`#ticker-price-${symbol}`);
        const changeEls = document.querySelectorAll(`#ticker-change-${symbol}`);
        
        const formattedPrice = `₹${data.price.toFixed(2)}`;
        const formattedChange = `${data.change_pct >= 0 ? '+' : ''}${data.change_pct.toFixed(2)}%`;
        const changeClass = data.change_pct >= 0 ? 'gain' : 'loss';
        
        priceEls.forEach(el => {
            el.textContent = formattedPrice;
        });
        changeEls.forEach(el => {
            el.textContent = formattedChange;
            el.className = `ticker-change ${changeClass}`;
        });
    }
}

// Watchlist search filter
let searchInput = document.getElementById('watchlist-search');
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toUpperCase();
        document.querySelectorAll('.watchlist-row').forEach(row => {
            const symbol = row.id.replace('wl-row-', '');
            row.style.display = symbol.includes(query) ? '' : 'none';
        });
    });
}

// --- Automated Trading Signals Console ---
let activeAlerts = [];

function renderHistoricalAlerts(alertsList) {
    const body = document.getElementById('alerts-log-body');
    const badge = document.getElementById('alerts-count');
    if (!body || !alertsList) return;
    
    activeAlerts = [...alertsList];
    badge.textContent = `${activeAlerts.length} Signals`;
    
    drawAlertsConsole();
}

function handleLiveAlert(alert) {
    const body = document.getElementById('alerts-log-body');
    const badge = document.getElementById('alerts-count');
    if (!body) return;
    
    // Add to top of alerts array
    activeAlerts.unshift(alert);
    
    // Limit to 40 signals max in memory
    if (activeAlerts.length > 40) {
        activeAlerts.pop();
    }
    
    badge.textContent = `${activeAlerts.length} Signals`;
    
    // Flash alerts container badge
    const header = document.querySelector('.alerts-panel');
    if (header) {
        header.classList.add(alert.sentiment === 'bullish' ? 'tick-up' : 'tick-down');
        setTimeout(() => {
            header.classList.remove('tick-up', 'tick-down');
        }, 1000);
    }
    
    // Also draw live alert marker dynamically on the TradingView chart
    if (candlestickSeries) {
        const alertTime = lastCandleTime || Math.floor(Date.now() / 1000);
        const shape = alert.sentiment === 'bullish' ? 'arrowUp' : (alert.sentiment === 'bearish' ? 'arrowDown' : 'circle');
        const color = alert.sentiment === 'bullish' ? '#10b981' : (alert.sentiment === 'bearish' ? '#f43f5e' : '#3b82f6');
        const position = alert.sentiment === 'bullish' ? 'belowBar' : (alert.sentiment === 'bearish' ? 'aboveBar' : 'inBar');
        
        const liveMarker = {
            time: alertTime,
            position: position,
            color: color,
            shape: shape,
            text: alert.pattern
        };
        
        // Fetch current active markers
        const currentSeriesMarkers = candlestickSeries.markers() || [];
        const exists = currentSeriesMarkers.some(m => m.time === alertTime && m.text === alert.pattern);
        
        if (!exists) {
            currentSeriesMarkers.push(liveMarker);
            // Sort chronologically
            currentSeriesMarkers.sort((a, b) => {
                const valA = typeof a.time === 'string' ? new Date(a.time).getTime() : a.time * 1000;
                const valB = typeof b.time === 'string' ? new Date(b.time).getTime() : b.time * 1000;
                return valA - valB;
            });
            candlestickSeries.setMarkers(currentSeriesMarkers);
        }
    }
    
    drawAlertsConsole();
}

function drawAlertsConsole() {
    const body = document.getElementById('alerts-log-body');
    if (!body) return;
    
    if (activeAlerts.length === 0) {
        body.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 1.5rem; font-size: 0.85rem;">
                Scanning markets. Waiting for pattern or wave signals...
            </div>
        `;
        return;
    }
    
    body.innerHTML = "";
    activeAlerts.forEach(alert => {
        const logRow = document.createElement('div');
        logRow.className = `alert-log-row ${alert.sentiment}`;
        
        let sentimentText = "NEUTRAL";
        let sentimentClass = "alert-badge neutral-badge";
        
        if (alert.sentiment === "bullish") {
            sentimentText = "BULLISH";
            sentimentClass = "alert-badge bullish-badge";
        } else if (alert.sentiment === "bearish") {
            sentimentText = "BEARISH";
            sentimentClass = "alert-badge bearish-badge";
        }
        
        logRow.innerHTML = `
            <span class="alert-time">${alert.time}</span>
            <span class="alert-symbol-tag" onclick="selectStock('${alert.symbol}')">${alert.symbol}</span>
            <span class="${sentimentClass}">${sentimentText}</span>
            <span class="alert-message">${alert.message}</span>
        `;
        body.appendChild(logRow);
    });
}

// Start WebSocket connection and chart with defensive safety boundaries
window.onload = () => {
    try {
        initTradingViewChart();
    } catch (e) {
        console.error("TradingView Chart initialization failed. External library may be blocked or loading slowly:", e);
    }
    
    try {
        connectWebSocket();
    } catch (e) {
        console.error("WebSocket connection trigger failed:", e);
    }
};

// Check if Indian Stock Market is open (9:15 AM - 3:30 PM IST, Mon-Fri)
function isMarketOpen() {
    const now = new Date();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    if (day === 0 || day === 6) return false;
    
    // Convert local browser time to IST (UTC + 5:30)
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utc + (3600000 * 5.5));
    
    const hour = ist.getHours();
    const minute = ist.getMinutes();
    const totalMinutes = hour * 60 + minute;
    
    const startMinutes = 9 * 60 + 15;
    const endMinutes = 15 * 60 + 30;
    
    return totalMinutes >= startMinutes && totalMinutes <= endMinutes;
}

// Custom Chart Markers State
let customMarkers = {}; // Keyed by stock symbol (e.g. customMarkers["RELIANCE"] = [...])

// Add custom text instruction / marker to the TradingView chart
function addCustomChartMarker() {
    const textInput = document.getElementById('marker-text');
    const shapeInput = document.getElementById('marker-shape');
    
    if (!textInput || !shapeInput || !candlestickSeries) return;
    
    const text = textInput.value.trim();
    const shape = shapeInput.value;
    
    if (!text) {
        alert("Please enter custom instruction text.");
        return;
    }
    
    // Use clicked time if available, otherwise default to latest
    let markerTime = selectedMarkerTime;
    if (!markerTime) {
        if (activeTimeline === "Live") {
            markerTime = lastCandleTime || Math.floor(Date.now() / 1000);
        } else if (lastHistoryCandle) {
            markerTime = lastHistoryCandle.time;
        } else {
            markerTime = Math.floor(Date.now() / 1000);
        }
    }
    
    const position = (shape === 'arrowUp') ? 'belowBar' : 'aboveBar';
    const color = (shape === 'arrowUp') ? '#10b981' : (shape === 'arrowDown' ? '#f43f5e' : '#3b82f6');
    
    const newMarker = {
        time: markerTime,
        position: position,
        color: color,
        shape: shape,
        text: text
    };
    
    if (!customMarkers[currentSymbol]) {
        customMarkers[currentSymbol] = [];
    }
    customMarkers[currentSymbol].push(newMarker);
    
    // Sort markers chronologically (Lightweight Charts strict requirement)
    customMarkers[currentSymbol].sort((a, b) => {
        const valA = typeof a.time === 'string' ? new Date(a.time).getTime() : a.time * 1000;
        const valB = typeof b.time === 'string' ? new Date(b.time).getTime() : b.time * 1000;
        return valA - valB;
    });
    
    // Set all markers on the series
    candlestickSeries.setMarkers(customMarkers[currentSymbol]);
    
    // Reset inputs
    textInput.value = "";
    selectedMarkerTime = null;
    const label = document.getElementById('selected-time-label');
    if (label) {
        label.textContent = "Click on any chart candle to target the marker there (defaults to latest)";
        label.style.color = "var(--text-secondary)";
    }
    
    // Update marker list table and badge
    renderMarkersTable();
    console.log(`Custom marker added to ${currentSymbol}:`, newMarker);
}
// Switch tabs between CHART, MARKERS, and F&O
function switchWorkspaceTab(tab) {
    const chartTabBtn = document.getElementById('tab-chart');
    const markersTabBtn = document.getElementById('tab-markers');
    const foTabBtn = document.getElementById('tab-fo');
    const aiTabBtn = document.getElementById('tab-ai');
    
    const chartView = document.getElementById('workspace-chart');
    const markersView = document.getElementById('workspace-markers');
    const foView = document.getElementById('workspace-fo');
    const aiView = document.getElementById('workspace-ai');
    
    if (!chartTabBtn || !markersTabBtn || !foTabBtn || !aiTabBtn || !chartView || !markersView || !foView || !aiView) return;
    
    activeWorkspaceTab = tab;
    
    // Reset all tabs styling
    [chartTabBtn, markersTabBtn, foTabBtn, aiTabBtn].forEach(btn => {
        btn.className = 'tab-btn';
        btn.style.borderBottom = 'none';
        btn.style.color = 'var(--text-secondary)';
        btn.style.fontWeight = '600';
    });
    
    // Hide all views
    chartView.style.display = 'none';
    markersView.style.display = 'none';
    foView.style.display = 'none';
    aiView.style.display = 'none';
    
    if (tab === 'chart') {
        chartTabBtn.className = 'tab-btn active';
        chartTabBtn.style.borderBottom = '2px solid var(--color-accent)';
        chartTabBtn.style.color = '#fff';
        chartTabBtn.style.fontWeight = '700';
        chartView.style.display = 'flex';
        
        // Resize chart to fit full expanded container
        if (chart) {
            const container = document.getElementById('chart-wrap');
            if (container) {
                chart.resize(container.clientWidth, container.clientHeight);
            }
        }
    } else if (tab === 'markers') {
        markersTabBtn.className = 'tab-btn active';
        markersTabBtn.style.borderBottom = '2px solid var(--color-accent)';
        markersTabBtn.style.color = '#fff';
        markersTabBtn.style.fontWeight = '700';
        markersView.style.display = 'flex';
        renderMarkersTable();
    } else if (tab === 'fo') {
        foTabBtn.className = 'tab-btn active';
        foTabBtn.style.borderBottom = '2px solid var(--color-accent)';
        foTabBtn.style.color = '#fff';
        foTabBtn.style.fontWeight = '700';
        foView.style.display = 'flex';
        renderOptionsChain();
    } else if (tab === 'ai') {
        aiTabBtn.className = 'tab-btn active';
        aiTabBtn.style.borderBottom = '2px solid var(--color-accent)';
        aiTabBtn.style.color = '#fff';
        aiTabBtn.style.fontWeight = '700';
        aiView.style.display = 'flex';
    }
}

// Render active custom markers in the table
function renderMarkersTable() {
    const tbody = document.getElementById('markers-table-body');
    const stockSpan = document.getElementById('markers-stock-name');
    if (!tbody || !stockSpan) return;
    
    stockSpan.textContent = currentSymbol;
    tbody.innerHTML = "";
    
    const markers = customMarkers[currentSymbol] || [];
    
    // Update marker count badge on the tab
    const badge = document.getElementById('marker-badge');
    if (badge) {
        if (markers.length > 0) {
            badge.textContent = markers.length;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
    
    if (markers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 3rem; font-size: 0.85rem;">No custom markers added for this stock yet.<br><br>Click the CHART tab, click on any candle to target it, and add markers!</td></tr>`;
        return;
    }
    
    markers.forEach((marker, idx) => {
        let displayTime = marker.time;
        if (typeof marker.time === 'number') {
            const date = new Date(marker.time * 1000);
            displayTime = date.toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
        }
        
        const shapeLabel = marker.shape === 'arrowUp' ? '🟢 Buy Signal' : (marker.shape === 'arrowDown' ? '🔴 Sell Signal' : (marker.shape === 'circle' ? '🔵 Info' : '🟡 Note'));
        
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255, 255, 255, 0.03)';
        tr.innerHTML = `
            <td style="padding: 0.75rem; color: #fff;">${displayTime}</td>
            <td style="padding: 0.75rem; color: #fff; font-weight:600;">${shapeLabel}</td>
            <td style="padding: 0.75rem; color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${marker.text}</td>
            <td style="padding: 0.75rem; text-align: right;">
                <button onclick="deleteCustomMarker(${idx})" style="background: none; border: none; color: var(--color-loss); font-weight: 700; cursor: pointer; padding: 0.25rem 0.5rem; border-radius: 4px; transition: all 0.2s;" onmouseover="this.style.background='rgba(244, 63, 94, 0.1)'" onmouseout="this.style.background='none'">Delete</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Delete custom marker
function deleteCustomMarker(idx) {
    if (!customMarkers[currentSymbol]) return;
    customMarkers[currentSymbol].splice(idx, 1);
    
    // Update chart (will fetch latest packet alerts and merge them)
    // For simplicity, we trigger a re-render of current active markers on chart
    if (candlestickSeries) {
        // Find latest auto markers if loaded in signal panel or trigger refetch
        // We will just clear custom markers and let the next socket sync re-draw
        // Or simply remove it from the combined set
        // A direct way is to fetch the current chart markers and filter out
        const currentSeriesMarkers = candlestickSeries.markers() || [];
        const userMarkers = customMarkers[currentSymbol] || [];
        // Re-apply custom markers + auto markers (we can just filter)
        candlestickSeries.setMarkers(userMarkers);
    }
    
    // Re-render table and badge
    renderMarkersTable();
}

// Fullscreen Chart state
let isChartFullScreen = false;

// Toggles fullscreen mode for the technical chart panel
function toggleFullScreenChart() {
    const chartPanel = document.querySelector('.chart-container');
    if (!chartPanel) return;
    
    isChartFullScreen = !isChartFullScreen;
    if (isChartFullScreen) {
        chartPanel.classList.add('fullscreen');
    } else {
        chartPanel.classList.remove('fullscreen');
    }
    
    // Resize chart to fit new viewport bounds after transition
    setTimeout(() => {
        if (chart) {
            const container = document.getElementById('chart-wrap');
            if (container) {
                chart.resize(container.clientWidth, container.clientHeight);
            }
        }
    }, 100);
}

// Exit fullscreen on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isChartFullScreen) {
        toggleFullScreenChart();
    }
});

// Programmatically zooms and fits the technical chart timescale
function zoomChart(direction) {
    if (!chart) return;
    if (direction === 'in') {
        chart.timeScale().zoomToChanges(2);
    } else if (direction === 'out') {
        chart.timeScale().zoomToChanges(-2);
    } else if (direction === 'reset') {
        chart.timeScale().fitContent();
        if (candlestickSeries) {
            candlestickSeries.priceScale().applyOptions({ autoScale: true });
        }
    }
}

// Switch news tabs categories
function switchNewsTab(tab) {
    if (tab !== 'latest' && tab !== 'global' && tab !== 'reddit') return;
    
    activeNewsTab = tab;
    
    // Update tab buttons active states
    document.querySelectorAll('.news-tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.style.background = 'none';
        btn.style.color = 'var(--text-secondary)';
        btn.style.fontWeight = '600';
    });
    
    const activeBtn = document.getElementById(`news-tab-${tab}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.background = 'var(--color-accent)';
        activeBtn.style.color = '#fff';
        activeBtn.style.fontWeight = '700';
    }
    
    // Reset rendering hash to force DOM rebuild
    currentNewsHash = "";
    renderNews(newsCacheData[tab] || []);
}

// Generate and render live options chain data
function renderOptionsChain() {
    const tbody = document.getElementById('fo-table-body');
    const futContract = document.getElementById('fut-contract-name');
    const futPriceEl = document.getElementById('fut-price');
    const futBasisEl = document.getElementById('fut-basis');
    const futOiEl = document.getElementById('fut-oi');
    const futOiSent = document.getElementById('fut-oi-sentiment');
    
    if (!tbody || !marketData || !marketData[currentSymbol]) return;
    
    const spotPrice = marketData[currentSymbol].price;
    const change = marketData[currentSymbol].change;
    
    // Set Futures info
    if (futContract) futContract.textContent = `${currentSymbol} 31-Jul FUT`;
    
    // Futures premium calculations
    const premium = spotPrice * 0.004; // 0.4% premium
    const futPrice = spotPrice + premium;
    if (futPriceEl) futPriceEl.textContent = `₹${futPrice.toFixed(2)}`;
    if (futBasisEl) {
        futBasisEl.textContent = `+${premium.toFixed(2)} (+0.40%)`;
        futBasisEl.className = change >= 0 ? 'gain' : 'loss';
    }
    
    // Open Interest estimates
    const isIndex = marketData[currentSymbol].is_index;
    const oiBase = isIndex ? 12000000 : 4500000;
    const currentOi = Math.round(oiBase + (spotPrice * 10));
    if (futOiEl) {
        futOiEl.textContent = isIndex ? `${(currentOi / 10000000).toFixed(2)} Cr` : `${(currentOi / 100000).toFixed(2)} Lakhs`;
    }
    
    // Sentiment
    if (futOiSent) {
        if (change >= 0) {
            futOiSent.textContent = "LONG BUILDUP";
            futOiSent.style.color = "var(--color-gain)";
            futOiSent.style.borderColor = "var(--color-gain)";
            futOiSent.style.background = "rgba(16, 185, 129, 0.15)";
        } else {
            futOiSent.textContent = "SHORT BUILDUP";
            futOiSent.style.color = "var(--color-loss)";
            futOiSent.style.borderColor = "var(--color-loss)";
            futOiSent.style.background = "rgba(244, 63, 94, 0.15)";
        }
    }
    
    // Strike intervals mapping
    let interval = 20;
    if (currentSymbol.includes("NIFTY") || currentSymbol === "SENSEX") {
        interval = currentSymbol === "SENSEX" ? 500 : 100;
    } else if (spotPrice > 3000) {
        interval = 50;
    } else if (spotPrice > 1000) {
        interval = 20;
    } else {
        interval = 10;
    }
    
    const atmStrike = Math.round(spotPrice / interval) * interval;
    const strikes = [];
    for (let i = -3; i <= 3; i++) {
        strikes.push(atmStrike + (i * interval));
    }
    
    tbody.innerHTML = "";
    
    strikes.forEach(strike => {
        const callDist = spotPrice - strike;
        const putDist = strike - spotPrice;
        
        // Options Black-Scholes estimate LTPs
        const timeValue = spotPrice * 0.015;
        const callLtp = Math.max(0.5, callDist + timeValue + (Math.random() - 0.5) * (spotPrice * 0.001));
        const putLtp = Math.max(0.5, putDist + timeValue + (Math.random() - 0.5) * (spotPrice * 0.001));
        
        // Option open interest base levels
        const callOi = (Math.exp(-Math.pow(callDist / (interval * 3.5), 2)) * (isIndex ? 45.0 : 18.0)).toFixed(1);
        const putOi = (Math.exp(-Math.pow(putDist / (interval * 3.5), 2)) * (isIndex ? 42.0 : 16.5)).toFixed(1);
        
        const isItmCall = strike < spotPrice;
        const isItmPut = strike > spotPrice;
        
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255, 255, 255, 0.03)';
        
        const callBg = isItmCall ? 'rgba(99, 102, 241, 0.04)' : 'transparent';
        const putBg = isItmPut ? 'rgba(99, 102, 241, 0.04)' : 'transparent';
        
        tr.innerHTML = `
            <td style="padding: 0.6rem 0.5rem; background: ${callBg}; color: var(--text-secondary); font-family: var(--font-mono);">${callOi}L</td>
            <td style="padding: 0.6rem 0.5rem; background: ${callBg}; color: #fff; font-weight: 700; font-family: var(--font-mono); border-right: 1px solid var(--border-color);">${callLtp.toFixed(2)}</td>
            <td style="padding: 0.6rem 0.5rem; background: rgba(255,255,255,0.015); font-weight: 800; color: var(--color-accent); font-family: var(--font-sans);">${strike}</td>
            <td style="padding: 0.6rem 0.5rem; background: ${putBg}; color: #fff; font-weight: 700; font-family: var(--font-mono); border-left: 1px solid var(--border-color);">${putLtp.toFixed(2)}</td>
            <td style="padding: 0.6rem 0.5rem; background: ${putBg}; color: var(--text-secondary); font-family: var(--font-mono);">${putOi}L</td>
        `;
        
        tbody.appendChild(tr);
    });
}

// Render dynamic AI market advisory updates
function handleAiAdvisory(data) {
    if (data.symbol !== currentSymbol) return;
    
    const verdictEl = document.getElementById('ai-verdict-text');
    const confidenceEl = document.getElementById('ai-confidence-text');
    const analysisEl = document.getElementById('ai-analysis-content');
    const logStreamEl = document.getElementById('ai-log-stream');
    
    if (!verdictEl || !confidenceEl || !analysisEl || !logStreamEl) return;
    
    // Update labels
    verdictEl.textContent = data.verdict;
    confidenceEl.textContent = data.confidence + "%";
    
    // Style verdict color
    if (data.verdict.includes("BUY")) {
        verdictEl.style.color = '#10b981'; // Green
    } else if (data.verdict.includes("SELL")) {
        verdictEl.style.color = '#f43f5e'; // Red
    } else {
        verdictEl.style.color = '#3b82f6'; // Blue
    }
    
    // Set formatted HTML detailed analysis
    analysisEl.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 0.8rem;">
            <div style="background: rgba(255,255,255,0.01); padding: 0.5rem; border-radius: 6px; border-left: 3px solid #6366f1;">
                <strong style="color: #a5b4fc; display: block; font-size: 0.75rem; text-transform: uppercase;">📊 Chart & Technical Setup</strong>
                <span style="color: #e5e7eb;">${data.analysis.chart}</span>
            </div>
            <div style="background: rgba(255,255,255,0.01); padding: 0.5rem; border-radius: 6px; border-left: 3px solid #10b981;">
                <strong style="color: #a7f3d0; display: block; font-size: 0.75rem; text-transform: uppercase;">⚖️ Orderbook Bids & Asks Flow</strong>
                <span style="color: #e5e7eb;">${data.analysis.orderbook}</span>
            </div>
            <div style="background: rgba(255,255,255,0.01); padding: 0.5rem; border-radius: 6px; border-left: 3px solid #3b82f6;">
                <strong style="color: #93c5fd; display: block; font-size: 0.75rem; text-transform: uppercase;">📰 Sentiment & News Catalyst</strong>
                <span style="color: #e5e7eb;">${data.analysis.news}</span>
            </div>
            <div style="border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.8rem; margin-top: 0.4rem;">
                <strong style="color: #f59e0b; font-size: 0.85rem; display: flex; align-items: center; gap: 0.35rem; text-transform: uppercase; letter-spacing: 0.5px;">
                    ⚡ UNFILTERED RECOMMENDATION (NO BS):
                </strong>
                <p style="margin: 0.35rem 0 0 0; color: #fff; font-weight: 600; font-size: 0.88rem; line-height: 1.5; font-style: italic;">
                    "${data.analysis.unfiltered}"
                </p>
            </div>
        </div>
    `;
    
    // Append to live logs list
    const logItem = document.createElement('div');
    logItem.style.borderBottom = '1px solid rgba(255, 255, 255, 0.03)';
    logItem.style.paddingBottom = '0.4rem';
    logItem.style.lineHeight = '1.4';
    
    let verdictColor = '#3b82f6';
    if (data.verdict.includes("BUY")) verdictColor = '#10b981';
    if (data.verdict.includes("SELL")) verdictColor = '#f43f5e';
    
    logItem.innerHTML = `
        <span style="color: var(--text-muted); font-size: 0.7rem;">[${data.timestamp}]</span>
        <strong style="color: ${verdictColor}; font-size: 0.75rem;">${data.verdict}</strong>
        <span style="color: var(--text-secondary); font-size: 0.7rem;">(${data.confidence}%)</span> - 
        <span style="color: #d1d5db;">${data.analysis.unfiltered}</span>
    `;
    
    logStreamEl.appendChild(logItem);
    
    // Auto scroll to bottom
    logStreamEl.scrollTop = logStreamEl.scrollHeight;
}
