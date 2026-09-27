-- Store uploaded product images in the database instead of depending on external URLs.
-- Additive only: existing Media/ProductImage rows keep their url values; new columns are nullable.
--   Media.data/size       : uploaded file bytes (MEDIUMBLOB, up to 16 MB) and byte length
--   Media.url/urlHash     : now optional (uploaded files have no external URL)
--   ProductImage.mediaId  : links an image to its uploaded Media (RESTRICT: in-use media can't be deleted)
--   ProductImage.url      : now optional (only legacy externally hosted images use it)

-- AlterTable
ALTER TABLE `Media` ADD COLUMN `data` MEDIUMBLOB NULL,
    ADD COLUMN `size` INTEGER NULL,
    MODIFY `url` VARCHAR(2048) NULL,
    MODIFY `urlHash` CHAR(64) NULL;
-- AlterTable
ALTER TABLE `ProductImage` ADD COLUMN `mediaId` VARCHAR(191) NULL,
    MODIFY `url` VARCHAR(2048) NULL;
-- CreateIndex
CREATE INDEX `ProductImage_mediaId_idx` ON `ProductImage`(`mediaId`);
-- AddForeignKey
ALTER TABLE `ProductImage` ADD CONSTRAINT `ProductImage_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
