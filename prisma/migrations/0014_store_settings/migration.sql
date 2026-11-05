CREATE TABLE `StoreSettings` (
    `id` VARCHAR(32) NOT NULL DEFAULT 'store',
    `storeName` VARCHAR(191) NOT NULL DEFAULT '',
    `supportEmail` VARCHAR(191) NOT NULL DEFAULT '',
    `supportPhone` VARCHAR(32) NOT NULL DEFAULT '',
    `currency` CHAR(3) NOT NULL DEFAULT '',
    `timezone` VARCHAR(100) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
