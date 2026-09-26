-- Data-only migration: give every existing identity its domain profile.
-- Insert-only and idempotent (skips users that already have a profile); no existing rows change.
-- Assumption: every pre-existing CUSTOMER is RETAIL, because B2B accounts did not exist before 0004.

INSERT INTO `AdminUser` (`id`, `userId`, `createdAt`, `updatedAt`)
SELECT UUID(), u.`id`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `User` u
LEFT JOIN `AdminUser` a ON a.`userId` = u.`id`
WHERE u.`role` = 'ADMIN' AND a.`id` IS NULL;

INSERT INTO `Customer` (`id`, `userId`, `customerType`, `createdAt`, `updatedAt`)
SELECT UUID(), u.`id`, 'RETAIL', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `User` u
LEFT JOIN `Customer` c ON c.`userId` = u.`id`
WHERE u.`role` = 'CUSTOMER' AND c.`id` IS NULL;
