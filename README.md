# AI Crypto Trading Agent

This project demonstrates an AI-powered trading agent that analyzes cryptocurrency market data and executes automated trading decisions.

The agent connects to the Coinbase Advanced Trade API and uses technical indicators to determine buy or sell signals.

![ai crypto trading agent](Architecture_Ai_Agent.png)

## Architecture

User Interface (React)
        |
Trading Logic Engine
        |
Technical Indicators
(RSI, MACD, SMA)
        |
Coinbase API
        |
Cryptocurrency Market

## Features

- real-time BTC price monitoring
- automated trading decision engine
- RSI momentum analysis
- MACD crossover detection
- SMA trend analysis
- automated market order execution

## Technologies

- React
- JavaScript
- Coinbase Advanced Trade API
- Web Crypto API
- Technical Analysis Algorithms

## Trading Strategy

The AI agent calculates multiple indicators:

RSI  
MACD  
SMA20 / SMA50  

The system assigns a score based on market conditions.

BUY → strong bullish signals  
SELL → strong bearish signals  
HOLD → neutral conditions

## Future Improvements

- Machine learning trading model
- backtesting engine
- portfolio risk management
- cloud deployment on AWS
