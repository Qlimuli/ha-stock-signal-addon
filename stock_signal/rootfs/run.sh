#!/usr/bin/with-contenv bashio
set -e

bashio::log.info "Starting Stock & ETF Signal Server..."

# Read options
TICKERS=$(bashio::config 'tickers')
ETF_TICKERS=$(bashio::config 'etf_tickers')
INTERVAL=$(bashio::config 'update_interval_minutes')
MQTT_ENABLED=$(bashio::config 'mqtt_enabled')
MQTT_PREFIX=$(bashio::config 'mqtt_topic_prefix')
RSI_OVERSOLD=$(bashio::config 'rsi_oversold')
RSI_OVERBOUGHT=$(bashio::config 'rsi_overbought')
LOOKBACK=$(bashio::config 'lookback_days')

export STOCK_TICKERS="$TICKERS"
export ETF_TICKERS="$ETF_TICKERS"
export UPDATE_INTERVAL_MINUTES="$INTERVAL"
export MQTT_ENABLED="$MQTT_ENABLED"
export MQTT_TOPIC_PREFIX="$MQTT_PREFIX"
export RSI_OVERSOLD="$RSI_OVERSOLD"
export RSI_OVERBOUGHT="$RSI_OVERBOUGHT"
export LOOKBACK_DAYS="$LOOKBACK"

# MQTT host from supervisor if available
if bashio::services.available "mqtt"; then
  export MQTT_HOST=$(bashio::services "mqtt" "host")
  export MQTT_PORT=$(bashio::services "mqtt" "port")
  export MQTT_USER=$(bashio::services "mqtt" "username")
  export MQTT_PASSWORD=$(bashio::services "mqtt" "password")
  bashio::log.info "MQTT service discovered"
else
  export MQTT_HOST="core-mosquitto"
  export MQTT_PORT="1883"
  bashio::log.warning "MQTT service not discovered, using defaults"
fi

bashio::log.info "Tickers: $TICKERS"
bashio::log.info "ETF Tickers: $ETF_TICKERS"
bashio::log.info "Update interval: ${INTERVAL} min"

exec python3 /app/main.py
