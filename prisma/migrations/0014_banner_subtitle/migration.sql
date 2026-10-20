-- Additive only: one nullable column for the hero heading's sub heading. No existing data changes.

-- AlterTable
ALTER TABLE `Banner` ADD COLUMN `subtitle` VARCHAR(500) NULL;
