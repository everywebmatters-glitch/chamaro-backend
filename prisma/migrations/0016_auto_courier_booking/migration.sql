-- Additive only: four nullable Product columns (one packed unit's weight and size), two Shipment columns with
-- defaults, and one new ShipmentStatus value appended at the end of the enum (MySQL adds it without rebuilding the
-- table; existing values keep their positions). No existing row changes; the previous API revision keeps working.

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `weightGrams` INTEGER NULL,
    ADD COLUMN `lengthCm` INTEGER NULL,
    ADD COLUMN `widthCm` INTEGER NULL,
    ADD COLUMN `heightCm` INTEGER NULL;

-- AlterTable
ALTER TABLE `Shipment` MODIFY `status` ENUM('CREATING', 'CREATE_FAILED', 'MANIFESTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_IN_TRANSIT', 'RETURNED', 'CANCELLED', 'QUEUED') NOT NULL DEFAULT 'CREATING',
    ADD COLUMN `autoBooked` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `nextAttemptAt` DATETIME(3) NULL;
