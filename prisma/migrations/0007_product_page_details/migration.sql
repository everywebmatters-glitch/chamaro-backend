-- Per-product content for the storefront's Description, Additional Information, Return Policies
-- and Warranty tabs, managed from Admin. Additive only: new nullable columns, no data changes.
--   features / materials : JSON arrays of strings (Description tab)
--   specifications       : JSON array of { label, value } (Additional Information tab)
--   returnPolicy / warranty : text; NULL means the storefront shows the store-wide default

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `features` JSON NULL,
    ADD COLUMN `materials` JSON NULL,
    ADD COLUMN `returnPolicy` TEXT NULL,
    ADD COLUMN `specifications` JSON NULL,
    ADD COLUMN `warranty` TEXT NULL;
