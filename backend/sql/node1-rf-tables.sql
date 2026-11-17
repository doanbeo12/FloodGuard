-- Optional experiment metadata and Random Forest evaluation tables.
-- Existing sensor telemetry is stored in node1_telemetry by backend/node1-api.js.
-- Run against your existing MySQL database in DBeaver.
CREATE TABLE IF NOT EXISTS rf_training_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_name VARCHAR(100) NOT NULL UNIQUE,
  scenario VARCHAR(60) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rf_session_times (started_at, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rf_predictions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  predicted_at DATETIME(3) NOT NULL,
  model_version VARCHAR(60) NOT NULL,
  target VARCHAR(32) NOT NULL,
  horizon_minutes INT UNSIGNED NOT NULL,
  probability DOUBLE NULL,
  predicted_label TINYINT(1) NULL,
  observed_label TINYINT(1) NULL,
  evaluated_at DATETIME(3) NULL,
  INDEX idx_rf_pred_target_time (target, predicted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rf_evaluations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  model_version VARCHAR(60) NOT NULL,
  target VARCHAR(32) NOT NULL,
  train_samples INT UNSIGNED NOT NULL,
  test_samples INT UNSIGNED NOT NULL,
  accuracy DOUBLE NULL,
  precision_score DOUBLE NULL,
  recall_score DOUBLE NULL,
  f1_score DOUBLE NULL,
  roc_auc DOUBLE NULL,
  notes VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
