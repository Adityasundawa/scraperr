-- Skema yang sama dengan yang dibuat scrape.mjs. Import ini di server kalau tabelnya belum ada.
CREATE DATABASE IF NOT EXISTS tadrama CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tadrama;

CREATE TABLE IF NOT EXISTS series (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  folder VARCHAR(255) NOT NULL,
  description TEXT,
  country VARCHAR(32),
  status VARCHAR(32),
  free_episode_limit INT,
  rating_average DECIMAL(4,2),
  rating_count INT,
  view_count BIGINT,
  featured_order DOUBLE,
  total_episodes INT,
  cover_key VARCHAR(512),
  thumbnail_url VARCHAR(1024),
  meta_url VARCHAR(1024),
  source_created_at DATETIME,
  source_updated_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_folder (folder), KEY idx_title (title)
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS episodes (
  series_id CHAR(36) NOT NULL,
  episode_number INT NOT NULL,
  source_episode_id CHAR(36),
  source_file VARCHAR(128),
  r2_key VARCHAR(600),
  url VARCHAR(1024),
  size_bytes BIGINT,
  duration DOUBLE,
  status ENUM('ok','locked','error') NOT NULL,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, episode_number),
  KEY idx_status (status),
  KEY idx_source_file (source_file),
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS subtitles (
  series_id CHAR(36) NOT NULL,
  episode_number INT NOT NULL,
  language VARCHAR(16) NOT NULL,
  r2_key VARCHAR(600),
  url VARCHAR(1024),
  PRIMARY KEY (series_id, episode_number, language),
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4;
