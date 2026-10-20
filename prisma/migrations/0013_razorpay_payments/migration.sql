-- Razorpay payments: one Payment row per gateway order, and the webhook deliveries already received.
--
-- Additive only: two new tables and one foreign key to RetailOrder. No existing column, index or enum value changes,
-- so code from before this migration keeps working against the migrated database (rolling back the API image needs no
-- database change). Numbered 0013 so it can ship before or after 0012_delhivery_shipments; neither depends on the other.
--
-- Manual rollback (only if the tables must go and no real payment was ever recorded; check first:
--   SELECT COUNT(*) FROM Payment;):
--   DROP TABLE PaymentWebhookEvent;
--   DROP TABLE Payment;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0013_razorpay_payments';
-- Never drop Payment once live payments exist: it is the only record linking an order to the money received.

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'RAZORPAY',
    `mode` VARCHAR(4) NOT NULL,
    `providerOrderId` VARCHAR(64) NOT NULL,
    `providerPaymentId` VARCHAR(64) NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `status` ENUM('CREATED', 'FAILED', 'AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED') NOT NULL DEFAULT 'CREATED',
    `amountRefundedMinor` INTEGER NOT NULL DEFAULT 0,
    `method` VARCHAR(32) NULL,
    `lastErrorCode` VARCHAR(64) NULL,
    `lastErrorReason` VARCHAR(64) NULL,
    `needsReview` BOOLEAN NOT NULL DEFAULT false,
    `reviewReason` VARCHAR(64) NULL,
    `authorizedAt` DATETIME(3) NULL,
    `capturedAt` DATETIME(3) NULL,
    `refundedAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Payment_providerOrderId_key`(`providerOrderId`),
    UNIQUE INDEX `Payment_providerPaymentId_key`(`providerPaymentId`),
    INDEX `Payment_orderId_idx`(`orderId`),
    INDEX `Payment_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Payment_needsReview_idx`(`needsReview`),
    INDEX `Payment_mode_status_idx`(`mode`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentWebhookEvent` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'RAZORPAY',
    `eventId` VARCHAR(64) NOT NULL,
    `event` VARCHAR(64) NOT NULL,
    `providerPaymentId` VARCHAR(64) NULL,
    `processedAt` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentWebhookEvent_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `RetailOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

