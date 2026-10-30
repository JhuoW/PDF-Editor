import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { applyCurrentWorkspaceFormValues } from '../../src/forms/WorkspaceFormValues';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage();
  const field = pdf.getForm().createTextField('Contact'); field.setText('Native value');
  field.addToPage(page, { x: 20, y: 20, width: 150, height: 25 });
  const data = buffer(await pdf.save()), workspace = createWorkspace(await extractFormFields(data));
  return { pdf, field, data, workspace };
}

describe('current workspace form values', () => {
  it('keeps unchanged native bytes even when the original-value baseline differs', async () => {
    const { data, workspace } = await fixture();
    workspace.form.originalValues.set(workspace.form.fields[0].id, 'Previous native version');
    workspace.form.isDirty = true;
    const result = await applyCurrentWorkspaceFormValues(data, workspace);
    expect(result).toEqual(new Uint8Array(data)); expect(result.buffer).not.toBe(data);
  });

  it('ignores missing stale names and newly read-only native fields without adding or rewriting anything', async () => {
    const { pdf, field, workspace } = await fixture();
    workspace.form.fields[0].value = 'Stale editable value';
    workspace.form.fields.push({ ...structuredClone(workspace.form.fields[0]), id: 'missing', name: 'Missing field' });
    field.enableReadOnly();
    const data = buffer(await pdf.save()), result = await applyCurrentWorkspaceFormValues(data, workspace);
    expect(result).toEqual(new Uint8Array(data));
    const native = (await PDFDocument.load(result)).getForm();
    expect(native.getFields()).toHaveLength(1); expect(native.getTextField('Contact').getText()).toBe('Native value');
  });

  it('observes cancellation before consuming a workspace or parsing source bytes', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(applyCurrentWorkspaceFormValues(new Uint8Array([1, 2]).buffer, createWorkspace(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
