-- DRAFT -- NOT EXECUTED. Review, replace the password placeholder, and run it yourself as an administrative
-- user (for example root, through the Cloud SQL Auth Proxy). Never commit a real password to this file.
--
-- chamaro_migrator exists only so `prisma migrate deploy` (the chamaro-migrate Cloud Run job) can create and alter
-- tables. The runtime account chamaro_app keeps SELECT/INSERT/UPDATE/DELETE only. `migrate deploy` needs no shadow
-- database, so no privileges outside the `chamaro` schema are granted.

CREATE USER 'chamaro_migrator'@'%' IDENTIFIED BY '<REPLACE_WITH_STRONG_PASSWORD>';

GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `chamaro`.* TO 'chamaro_migrator'@'%';

-- Prisma's own bookkeeping table (_prisma_migrations) is created inside `chamaro` by the grants above.
-- If a future migration adds triggers, views or routines, add TRIGGER / CREATE VIEW / CREATE ROUTINE / ALTER ROUTINE
-- here deliberately rather than granting ALL.
