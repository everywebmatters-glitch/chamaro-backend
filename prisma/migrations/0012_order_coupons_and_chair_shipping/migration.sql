-- Store one-time coupon redemption on the order. MySQL permits multiple NULL values in a
-- unique index, while a customer can only have one order per non-NULL coupon code.
ALTER TABLE `RetailOrder`
    ADD COLUMN `discountCode` VARCHAR(32) NULL,
    ADD COLUMN `discountTotal` DECIMAL(12, 2) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX `RetailOrder_customerId_discountCode_key`
    ON `RetailOrder`(`customerId`, `discountCode`);
