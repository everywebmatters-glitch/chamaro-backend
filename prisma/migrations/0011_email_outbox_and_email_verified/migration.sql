-- Additive only: one nullable User column (no default, so existing accounts stay NULL = never verified; MySQL 8
-- adds it in place without rebuilding the table) and a new EmailNotification table. No existing data changes.

-- AlterTable
ALTER TABLE `User` ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `EmailNotification` (
    `id` VARCHAR(191) NOT NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `toEmail` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,
    `subject` VARCHAR(255) NOT NULL,
    `html` MEDIUMTEXT NOT NULL,
    `text` TEXT NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `skipReason` VARCHAR(64) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedUntil` DATETIME(3) NULL,
    `lastErrorName` VARCHAR(64) NULL,
    `lastErrorStatus` INTEGER NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EmailNotification_eventKey_key`(`eventKey`),
    INDEX `EmailNotification_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `EmailNotification_userId_idx`(`userId`),
    INDEX `EmailNotification_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EmailNotification` ADD CONSTRAINT `EmailNotification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailNotification` ADD CONSTRAINT `EmailNotification_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `RetailOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
