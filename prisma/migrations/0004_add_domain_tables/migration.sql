-- CreateTable
CREATE TABLE `AdminUser` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AdminUser_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Customer` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `customerType` ENUM('RETAIL', 'B2B') NOT NULL DEFAULT 'RETAIL',
    `phone` VARCHAR(32) NULL,
    `companyName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Customer_userId_key`(`userId`),
    INDEX `Customer_customerType_idx`(`customerType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RetailAddress` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(32) NOT NULL,
    `addressLine1` VARCHAR(255) NOT NULL,
    `addressLine2` VARCHAR(255) NULL,
    `city` VARCHAR(120) NOT NULL,
    `state` VARCHAR(120) NOT NULL,
    `postalCode` VARCHAR(20) NOT NULL,
    `country` VARCHAR(2) NOT NULL,
    `type` ENUM('SHIPPING', 'BILLING') NOT NULL DEFAULT 'SHIPPING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RetailAddress_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Cart` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Cart_customerId_key`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CartItem` (
    `id` VARCHAR(191) NOT NULL,
    `cartId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CartItem_productId_idx`(`productId`),
    INDEX `CartItem_variantId_idx`(`variantId`),
    UNIQUE INDEX `CartItem_cartId_productId_variantId_key`(`cartId`, `productId`, `variantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RetailOrder` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL,
    `shippingAddressId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RetailOrder_customerId_createdAt_idx`(`customerId`, `createdAt`),
    INDEX `RetailOrder_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `RetailOrder_shippingAddressId_idx`(`shippingAddressId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RetailOrderItem` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(12, 2) NOT NULL,

    INDEX `RetailOrderItem_orderId_idx`(`orderId`),
    INDEX `RetailOrderItem_productId_idx`(`productId`),
    INDEX `RetailOrderItem_variantId_idx`(`variantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `B2BEnquiry` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `status` ENUM('NEW', 'CONTACTED', 'REQUIREMENT_RECEIVED', 'QUOTATION_SENT', 'NEGOTIATING', 'CONVERTED', 'CLOSED') NOT NULL DEFAULT 'NEW',
    `companyName` VARCHAR(191) NOT NULL,
    `contactName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(32) NULL,
    `message` TEXT NULL,
    `expectedTimeline` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `B2BEnquiry_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `B2BEnquiry_customerId_idx`(`customerId`),
    INDEX `B2BEnquiry_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `B2BEnquiryItem` (
    `id` VARCHAR(191) NOT NULL,
    `enquiryId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `requirements` TEXT NULL,
    `notes` TEXT NULL,

    INDEX `B2BEnquiryItem_enquiryId_idx`(`enquiryId`),
    INDEX `B2BEnquiryItem_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `B2BQuotation` (
    `id` VARCHAR(191) NOT NULL,
    `enquiryId` VARCHAR(191) NOT NULL,
    `quotationNumber` VARCHAR(64) NOT NULL,
    `status` ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'DRAFT',
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL,
    `validUntil` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `B2BQuotation_quotationNumber_key`(`quotationNumber`),
    INDEX `B2BQuotation_enquiryId_idx`(`enquiryId`),
    INDEX `B2BQuotation_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `B2BQuotationItem` (
    `id` VARCHAR(191) NOT NULL,
    `quotationId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL,

    INDEX `B2BQuotationItem_quotationId_idx`(`quotationId`),
    INDEX `B2BQuotationItem_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AdminUser` ADD CONSTRAINT `AdminUser_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `Customer_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RetailAddress` ADD CONSTRAINT `RetailAddress_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Cart` ADD CONSTRAINT `Cart_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `Cart`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RetailOrder` ADD CONSTRAINT `RetailOrder_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RetailOrder` ADD CONSTRAINT `RetailOrder_shippingAddressId_fkey` FOREIGN KEY (`shippingAddressId`) REFERENCES `RetailAddress`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RetailOrderItem` ADD CONSTRAINT `RetailOrderItem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `RetailOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RetailOrderItem` ADD CONSTRAINT `RetailOrderItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RetailOrderItem` ADD CONSTRAINT `RetailOrderItem_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `B2BEnquiry` ADD CONSTRAINT `B2BEnquiry_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `B2BEnquiryItem` ADD CONSTRAINT `B2BEnquiryItem_enquiryId_fkey` FOREIGN KEY (`enquiryId`) REFERENCES `B2BEnquiry`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `B2BEnquiryItem` ADD CONSTRAINT `B2BEnquiryItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `B2BQuotation` ADD CONSTRAINT `B2BQuotation_enquiryId_fkey` FOREIGN KEY (`enquiryId`) REFERENCES `B2BEnquiry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `B2BQuotationItem` ADD CONSTRAINT `B2BQuotationItem_quotationId_fkey` FOREIGN KEY (`quotationId`) REFERENCES `B2BQuotation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `B2BQuotationItem` ADD CONSTRAINT `B2BQuotationItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

