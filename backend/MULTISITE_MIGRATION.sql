-- Backend v1.6.0 Multi-Site
-- Có thể chạy từng câu trong DBeaver. Không xóa dữ liệu sensor_readings.

CREATE TABLE IF NOT EXISTS monitoring_sites (
    site_id INT AUTO_INCREMENT PRIMARY KEY,
    site_name VARCHAR(100) NOT NULL,
    street_name VARCHAR(150),
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    description VARCHAR(255),
    tide_station VARCHAR(50)
);

INSERT INTO monitoring_sites
(site_id, site_name, street_name, latitude, longitude, description, tide_station)
VALUES
(1, 'Đường số 1', 'Đường số 1', NULL, NULL, 'Điểm giám sát thực nghiệm - gồm Node 1 và Node 2', 'THU_DAU_MOT'),
(2, 'Đường số 2', 'Đường số 2', NULL, NULL, 'Chưa triển khai cảm biến', NULL),
(3, 'Đường số 3', 'Đường số 3', NULL, NULL, 'Chưa triển khai cảm biến', NULL)
ON DUPLICATE KEY UPDATE
site_name = VALUES(site_name),
street_name = VALUES(street_name),
description = VALUES(description),
tide_station = VALUES(tide_station);

-- Chỉ chạy ALTER ADD COLUMN nếu database của bạn CHƯA có site_id.
-- ALTER TABLE sensor_readings ADD COLUMN site_id INT NULL;

UPDATE sensor_readings SET site_id = 1 WHERE site_id IS NULL;

-- Chỉ chạy câu dưới nếu chưa có index idx_sensor_site.
-- ALTER TABLE sensor_readings ADD INDEX idx_sensor_site (site_id);

-- Chỉ chạy câu dưới nếu chưa có foreign key fk_sensor_site.
-- ALTER TABLE sensor_readings
-- ADD CONSTRAINT fk_sensor_site
-- FOREIGN KEY (site_id) REFERENCES monitoring_sites(site_id);

-- Nếu bảng monitoring_sites của bạn đã tồn tại mà chưa có tide_station, chạy riêng:
-- ALTER TABLE monitoring_sites ADD COLUMN tide_station VARCHAR(50) NULL AFTER description;
-- UPDATE monitoring_sites SET tide_station = 'THU_DAU_MOT' WHERE site_id = 1;
