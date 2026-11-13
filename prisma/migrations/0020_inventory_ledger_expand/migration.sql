-- Inventory ledger, EXPAND stage (additive only; no existing column or row is changed).
-- New: Product.inventoryPolicy (default TRACKED) and Product.stockLevel (default PRODUCT); nullable RetailOrder.stockState;
-- VariantInventory, StockMovement (append-only ledger), ReturnInspection, InventoryMigration (backfill snapshot).
-- Nothing reads these until the switch-over stage; NOT NULL and CHECK constraints come in the contract stage.

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `inventoryPolicy` ENUM('TRACKED', 'UNLIMITED') NOT NULL DEFAULT 'TRACKED',
    ADD COLUMN `stockLevel` ENUM('PRODUCT', 'VARIANT') NOT NULL DEFAULT 'PRODUCT';

-- AlterTable
ALTER TABLE `RetailOrder` ADD COLUMN `stockState` ENUM('NONE', 'RESERVED', 'COMMITTED', 'RELEASED') NULL;

-- CreateTable
CREATE TABLE `VariantInventory` (
    `id` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `onHand` INTEGER NOT NULL DEFAULT 0,
    `reserved` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VariantInventory_variantId_key`(`variantId`),
    INDEX `VariantInventory_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockMovement` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('RESERVE', 'RELEASE', 'COMMIT', 'ADJUST', 'COUNT', 'RESTOCK', 'RETURN_REJECTED', 'MIGRATION', 'UNTRACKED_SALE', 'POLICY_CHANGE') NOT NULL,
    `stockKey` VARCHAR(80) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `onHandDelta` INTEGER NOT NULL DEFAULT 0,
    `reservedDelta` INTEGER NOT NULL DEFAULT 0,
    `actorUserId` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StockMovement_stockKey_createdAt_idx`(`stockKey`, `createdAt`),
    INDEX `StockMovement_orderId_idx`(`orderId`),
    INDEX `StockMovement_productId_idx`(`productId`),
    UNIQUE INDEX `StockMovement_orderId_stockKey_kind_key`(`orderId`, `stockKey`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReturnInspection` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `orderItemId` VARCHAR(191) NOT NULL,
    `sellable` INTEGER NOT NULL,
    `rejected` INTEGER NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `inspectedBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReturnInspection_orderId_idx`(`orderId`),
    INDEX `ReturnInspection_orderItemId_idx`(`orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InventoryMigration` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `oldQuantity` INTEGER NOT NULL,
    `oldReserved` INTEGER NOT NULL,
    `committedUnits` INTEGER NOT NULL,
    `newOnHand` INTEGER NOT NULL,
    `newReserved` INTEGER NOT NULL,
    `migratedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `InventoryMigration_productId_key`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `RetailOrder_stockState_idx` ON `RetailOrder`(`stockState`);

-- AddForeignKey
ALTER TABLE `VariantInventory` ADD CONSTRAINT `VariantInventory_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
