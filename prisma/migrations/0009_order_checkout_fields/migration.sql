-- AlterTable
ALTER TABLE `RetailOrder` ADD COLUMN `idempotencyKey` VARCHAR(64) NULL,
    ADD COLUMN `note` TEXT NULL,
    ADD COLUMN `paymentStatus` ENUM('UNPAID', 'PAID', 'REFUNDED') NOT NULL DEFAULT 'UNPAID',
    ADD COLUMN `shippingAddressSnapshot` JSON NULL,
    ADD COLUMN `shippingMethod` VARCHAR(32) NULL,
    ADD COLUMN `shippingTotal` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `RetailOrderItem` ADD COLUMN `productName` VARCHAR(191) NULL,
    ADD COLUMN `sku` VARCHAR(191) NULL,
    ADD COLUMN `variantName` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `RetailOrder_customerId_idempotencyKey_key` ON `RetailOrder`(`customerId`, `idempotencyKey`);

