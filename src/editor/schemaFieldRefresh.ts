import * as Blockly from 'blockly';

import { FieldColumnMultiSelect } from './FieldColumnMultiSelect';

const SCHEMA_DROPDOWN_FIELD_NAMES = new Set([
  'COLUMN_ID',
  'COPY_COLUMN_ID',
]);

export function refreshWorkspaceSchemaFields(workspace: Blockly.Workspace) {
  workspace.getAllBlocks(false).forEach((block) => {
    block.inputList.forEach((input) => {
      input.fieldRow.forEach((field) => {
        if (field instanceof FieldColumnMultiSelect) {
          field.forceRerender();
          return;
        }

        if (!(field instanceof Blockly.FieldDropdown) || !field.isOptionListDynamic()) {
          return;
        }

        if (!field.name || !SCHEMA_DROPDOWN_FIELD_NAMES.has(field.name)) {
          return;
        }

        field.getOptions(false);

        const value = field.getValue();

        if (typeof value === 'string' && value !== '') {
          field.setValue(value, false);
          return;
        }

        field.forceRerender();
      });
    });
  });
}
