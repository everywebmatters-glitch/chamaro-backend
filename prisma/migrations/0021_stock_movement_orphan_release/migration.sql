-- Inventory ledger, EXPAND stage (additive only; no existing column or row is changed).
-- Admin release of orphaned reservations: new movement kind ORPHAN_RELEASE (appended to the enum, so existing values
-- keep their positions), and three nullable columns on StockMovement: the request's idempotency/reference key (unique)
-- and the reserved units before and after. Existing rows get NULL; no table is rewritten for data.

-- AlterTable
ALTER TABLE `StockMovement` ADD COLUMN `reference` VARCHAR(80) NULL,
    ADD COLUMN `reservedAfter` INTEGER NULL,
    ADD COLUMN `reservedBefore` INTEGER NULL,
    MODIFY `kind` ENUM('RESERVE', 'RELEASE', 'COMMIT', 'ADJUST', 'COUNT', 'RESTOCK', 'RETURN_REJECTED', 'MIGRATION', 'UNTRACKED_SALE', 'POLICY_CHANGE', 'ORPHAN_RELEASE') NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `StockMovement_reference_key` ON `StockMovement`(`reference`);
