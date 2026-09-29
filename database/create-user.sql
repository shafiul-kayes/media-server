-- Creates the database and a dedicated, least-privilege MySQL user for the media server.
-- Run once as an administrator (root), after replacing the password:
--   mysql -u root -p < database/create-user.sql
--
-- The app needs only data access plus the DDL used by its migrations. It never needs
-- FILE, SUPER, PROCESS, GRANT OPTION or access to any other database.

CREATE DATABASE IF NOT EXISTS media_server CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use '%' instead of 'localhost' only if the app runs on a different machine,
-- and then restrict it to that machine's IP, e.g. 'media_server'@'10.0.0.5'.
CREATE USER IF NOT EXISTS 'media_server'@'localhost' IDENTIFIED BY 'CHANGE_ME_to_a_long_random_password';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON media_server.* TO 'media_server'@'localhost';

FLUSH PRIVILEGES;
