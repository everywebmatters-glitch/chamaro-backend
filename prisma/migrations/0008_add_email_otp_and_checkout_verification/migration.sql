-- CreateTable
CREATE TABLE `EmailOtp` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `purpose` ENUM('LOGIN', 'FORGOT_PASSWORD', 'CHECKOUT_PAYMENT', 'EMAIL_VERIFICATION') NOT NULL,
    `otpHash` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmailOtp_email_purpose_consumedAt_idx`(`email`, `purpose`, `consumedAt`),
    INDEX `EmailOtp_userId_purpose_idx`(`userId`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CheckoutVerification` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CheckoutVerification_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CheckoutVerification` ADD CONSTRAINT `CheckoutVerification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
