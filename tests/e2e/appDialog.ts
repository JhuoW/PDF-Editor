import { expect, type Page } from '@playwright/test';

/** Accepts the in-app confirmation/alert/prompt dialog and returns its message. */
export async function acceptAppDialog(page: Page, value?: string) {
  const dialog = page.locator('dialog.confirmation-dialog-overlay').last();
  await expect(dialog).toBeVisible();
  const message = await dialog.locator('.confirmation-dialog-message').innerText();
  if (value !== undefined) await dialog.locator('.confirmation-dialog-input').fill(value);
  await dialog.locator('.confirmation-dialog-button.confirm').click();
  await expect(dialog).toHaveCount(0);
  return message;
}
