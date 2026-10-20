-- Additive only: two nullable Product columns and a new Review table. No existing data changes.

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `infoBoxes` JSON NULL,
    ADD COLUMN `shortDescription` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `Review` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `authorName` VARCHAR(191) NOT NULL,
    `rating` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'HIDDEN') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Review_productId_status_createdAt_idx`(`productId`, `status`, `createdAt`),
    INDEX `Review_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `Review_productId_userId_key`(`productId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
