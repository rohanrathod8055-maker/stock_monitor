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
            secondsVisible: false,
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
        
        // Re-apply any custom markers saved for this stock symbol
        const markers = customMarkers[currentSymbol] || [];
        if (candlestickSeries) {
            candlestickSeries.setMarkers(markers);
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
    const marketData = data.market_data;
    const selectedStock = data.selected_stock;
    const stockDetail = data.selected_stock_detail;
    const news = data.news;
    
    currentSymbol = selectedStock;
    
    renderTickerTape(marketData);
    renderIndices(marketData);
    renderWatchlist(marketData, currentSymbol);
    renderActiveStockDetail(marketData[currentSymbol] || stockDetail);
    renderMarketDepth(marketData[currentSymbol] || stockDetail);
    renderNews(news);
    
    // Update Candlestick Chart in Real-Time
    const tickPrice = marketData[currentSymbol].price;
    const tickVol = marketData[currentSymbol].volume;
    updateLiveChartTick(tickPrice, tickVol);
}

// Updates the TradingView candlestick structure dynamically with 1s ticks
function updateLiveChartTick(price, volume) {
    if (!candlestickSeries) return;
    
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
                No news articles available.
            </div>
        `;
        return;
    }
    
    container.innerHTML = "";
    newsList.forEach(item => {
        const card = document.createElement('div');
        card.className = 'news-card';
        card.innerHTML = `
            <div class="news-header">
                <span class="news-source">${item.source}</span>
                <span class="news-time">${item.published}</span>
            </div>
            <a href="${item.link}" target="_blank" class="news-title">${item.title}</a>
            <p class="news-desc">${item.summary}</p>
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
    console.log(`Custom marker added to ${currentSymbol}:`, newMarker);
}
