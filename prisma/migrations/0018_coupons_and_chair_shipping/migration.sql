-- Server-priced coupons and standard delivery for orders containing two or more chairs.
ALTER TABLE `RetailOrder`
    ADD COLUMN `discountTotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `couponCode` VARCHAR(32) NULL;

CREATE UNIQUE INDEX `RetailOrder_customerId_couponCode_key`
    ON `RetailOrder`(`customerId`, `couponCode`);
