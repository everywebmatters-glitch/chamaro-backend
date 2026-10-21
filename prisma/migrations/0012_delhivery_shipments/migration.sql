-- Additive only: three new tables (Shipment, ShipmentEvent, ShipmentPickupRequest) for the Delhivery courier
-- integration. No existing table or row changes; the previous API revision keeps working on this schema.
-- CreateTable
CREATE TABLE `Shipment` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'DELHIVERY',
    `status` ENUM('CREATING', 'CREATE_FAILED', 'MANIFESTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_IN_TRANSIT', 'RETURNED', 'CANCELLED') NOT NULL DEFAULT 'CREATING',
    `waybill` VARCHAR(64) NULL,
    `providerOrderRef` VARCHAR(64) NOT NULL,
    `uploadWbn` VARCHAR(64) NULL,
    `providerStatus` VARCHAR(64) NULL,
    `providerStatusType` VARCHAR(16) NULL,
    `providerStatusAt` DATETIME(3) NULL,
    `providerStatusLocation` VARCHAR(191) NULL,
    `trackingUrl` VARCHAR(2048) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `needsReconcile` BOOLEAN NOT NULL DEFAULT false,
    `lastErrorCode` VARCHAR(64) NULL,
    `lastErrorRemark` VARCHAR(255) NULL,
    `weightGrams` INTEGER NULL,
    `lengthCm` INTEGER NULL,
    `widthCm` INTEGER NULL,
    `heightCm` INTEGER NULL,
    `manifestedAt` DATETIME(3) NULL,
    `pickedUpAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Shipment_orderId_key`(`orderId`),
    UNIQUE INDEX `Shipment_waybill_key`(`waybill`),
    INDEX `Shipment_status_lastSyncedAt_idx`(`status`, `lastSyncedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShipmentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `shipmentId` VARCHAR(191) NOT NULL,
    `eventKey` CHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL,
    `statusType` VARCHAR(16) NULL,
    `location` VARCHAR(191) NULL,
    `instructions` VARCHAR(500) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ShipmentEvent_eventKey_key`(`eventKey`),
    INDEX `ShipmentEvent_shipmentId_occurredAt_idx`(`shipmentId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShipmentPickupRequest` (
    `id` VARCHAR(191) NOT NULL,
    `pickupLocation` VARCHAR(191) NOT NULL,
    `pickupDate` VARCHAR(10) NOT NULL,
    `pickupTime` VARCHAR(8) NOT NULL,
    `expectedPackageCount` INTEGER NOT NULL,
    `status` ENUM('REQUESTING', 'REQUESTED', 'FAILED', 'OUTCOME_UNKNOWN') NOT NULL DEFAULT 'REQUESTING',
    `providerPickupId` VARCHAR(64) NULL,
    `lastErrorCode` VARCHAR(64) NULL,
    `lastErrorRemark` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShipmentPickupRequest_pickupLocation_pickupDate_key`(`pickupLocation`, `pickupDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `RetailOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShipmentEvent` ADD CONSTRAINT `ShipmentEvent_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

