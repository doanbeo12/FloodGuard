-- FloodGuard v2: inspect required MySQL forecast table schemas (read-only).
-- No tables or data are modified.
SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_KEY
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='floodguard_v2'
  AND TABLE_NAME IN ('forecast_runs','forecast_inputs','rain_forecasts','tide_forecasts','flood_forecasts','sensor_channels')
ORDER BY FIELD(TABLE_NAME,'forecast_runs','forecast_inputs','rain_forecasts','tide_forecasts','flood_forecasts','sensor_channels'),ORDINAL_POSITION;

SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA='floodguard_v2'
  AND TABLE_NAME IN ('forecast_runs','forecast_inputs','rain_forecasts','tide_forecasts','flood_forecasts')
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME,COLUMN_NAME;
