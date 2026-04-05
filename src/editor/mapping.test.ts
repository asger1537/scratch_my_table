import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCsvWorkbook } from '../domain/csv';
import { getActiveTable, type Table } from '../domain/model';
import { executeWorkflow, type Workflow, type WorkflowExpression } from '../workflow';

import { type AuthoringWorkflow, authoringWorkflowToWorkflow, workflowToAuthoringWorkflow } from './authoring';
import { wrapCommentDisplayLines } from './FieldCommentInput';
import { formatColumnSelectionSummary, getSelectableColumnTypeGroups, getSelectableColumns, serializeColumnSelectionValue } from './FieldColumnMultiSelect';
import { BLOCK_TYPES } from './blocks';
import { runWorkspaceWorkflow, validateWorkspaceWorkflow } from './integration';
import {
  collectWorkflowColumnIds,
  createHeadlessWorkflowWorkspace,
  getSchemaColumnOptions,
  getWorkspaceMetadata,
  parseWorkflowJson,
  projectWorkspaceStepSchemas,
  setEditorSchemaColumns,
  workflowToJson,
  workflowToWorkspace,
  workspaceToAuthoringWorkflow,
  workspaceToWorkflow,
} from './index';

describe('block-based workflow authoring', () => {
  it('loads a simple scoped rule as one compact step block with nested function blocks', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_normalize_email',
      name: 'Normalize email',
      description: 'Lowercase trimmed email values.',
      steps: [
        {
          id: 'step_normalize_email',
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: call('lower', call('trim', value())),
          },
        },
      ],
    };
    const workspace = buildWorkspaceFromTable(table, workflow);
    const authored = workspaceToAuthoringWorkflow(workspace);
    const [topBlock] = workspace.getTopBlocks(false);
    const authoredStep = authored.workflow?.steps[0];

    if (!authoredStep || authoredStep.kind !== 'scopedRule') {
      throw new Error('Expected a scoped rule authoring step.');
    }

    expect(workspace.getTopBlocks(false)).toHaveLength(1);
    expect(workspace.getAllBlocks(false).map((block) => block.type).sort()).toEqual([
      BLOCK_TYPES.currentValueExpression,
      BLOCK_TYPES.lowerFunction,
      BLOCK_TYPES.scopedRuleCasesStep,
      BLOCK_TYPES.setValueActionItem,
      BLOCK_TYPES.trimFunction,
    ]);
    expect(topBlock?.type).toBe(BLOCK_TYPES.scopedRuleCasesStep);
    expect(getWorkspaceMetadata(workspace)).toEqual({
      workflowId: workflow.workflowId,
      name: workflow.name,
      description: workflow.description,
    });
    expect(authored.issues).toEqual([]);
    expect(authoredStep.columnIds).toEqual(['col_email']);
    expect(authoredStep.mode).toBe('single');
    expect(authoredStep.singlePatch).toEqual({
      valueEnabled: true,
      value: call('lower', call('trim', value())),
      formatEnabled: false,
    });
  });

  it('compiles multi-select scoped rules with row conditions directly to canonical v2 IR', () => {
    const authoringWorkflow: AuthoringWorkflow = {
      metadata: {
        workflowId: 'wf_scoped_rule',
        name: 'Scoped rule',
      },
      steps: [
        {
          kind: 'scopedRule',
          columnIds: ['col_first_name', 'col_last_name'],
          rowCondition: call(
            'and',
            call('startsWith', column('col_first_name'), literal('A')),
            call('startsWith', column('col_last_name'), literal('A')),
          ),
          mode: 'single',
          singlePatch: {
            valueEnabled: true,
            value: call('substring', value(), literal(0), literal(3)),
            formatEnabled: false,
            fillColor: '#ffeb9c',
          },
          cases: [],
          defaultPatch: {
            valueEnabled: false,
            formatEnabled: false,
            fillColor: '#ffeb9c',
          },
        },
      ],
    };

    const compiled = authoringWorkflowToWorkflow(authoringWorkflow);

    expect(compiled.issues).toEqual([]);
    expect(compiled.workflow).toEqual({
      version: 2,
      workflowId: 'wf_scoped_rule',
      name: 'Scoped rule',
      description: undefined,
      steps: [
        {
          id: 'step_scoped_rule_1',
          type: 'scopedRule',
          columnIds: ['col_first_name', 'col_last_name'],
          rowCondition: call(
            'and',
            call('startsWith', column('col_first_name'), literal('A')),
            call('startsWith', column('col_last_name'), literal('A')),
          ),
          defaultPatch: {
            value: call('substring', value(), literal(0), literal(3)),
          },
        },
      ],
    });
  });

  it('roundtrips comment steps through Blockly without semantic loss', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_comment_roundtrip',
      name: 'Comment roundtrip',
      steps: [
        {
          id: 'step_note_email_cleanup',
          type: 'comment',
          text: 'Normalize email values before any downstream filtering.',
        },
        {
          id: 'step_normalize_email',
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: call('lower', call('trim', value())),
          },
        },
      ],
    };

    const workspace = buildWorkspaceFromTable(table, workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(workspace.getAllBlocks(false).some((block) => block.type === BLOCK_TYPES.commentStep)).toBe(true);
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('roundtrips format-only scoped rules through Blockly without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_color_status',
      name: 'Color status',
      steps: [
        {
          id: 'step_color_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          rowCondition: call('equals', column('col_vip'), literal(true)),
          defaultPatch: {
            format: {
              fillColor: '#ffeb9c',
            },
          },
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_status', 'col_vip'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);
    const [topBlock] = workspace.getTopBlocks(false);
    const defaultActionBlock = topBlock?.getInputTargetBlock('DEFAULT_ACTIONS');
    const defaultColorBlock = defaultActionBlock?.getInputTargetBlock('COLOR');

    expect(topBlock?.type).toBe(BLOCK_TYPES.scopedRuleCasesStep);
    expect(defaultActionBlock?.type).toBe(BLOCK_TYPES.highlightActionItem);
    expect(defaultColorBlock?.type).toBe(BLOCK_TYPES.literalColor);
    expect(defaultColorBlock?.getFieldValue('VALUE')).toBe('#ffeb9c');
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('roundtrips case-based scoped rules through the dedicated cases block', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_status_cases',
      name: 'Status cases',
      steps: [
        {
          id: 'step_status_cases',
          type: 'scopedRule',
          columnIds: ['col_status'],
          cases: [
            {
              when: call('isEmpty', call('trim', value())),
              then: {
                value: literal('unknown'),
                format: {
                  fillColor: '#ffeb9c',
                },
              },
            },
          ],
          defaultPatch: {
            value: call('lower', call('trim', value())),
          },
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_status'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);
    const [topBlock] = workspace.getTopBlocks(false);

    expect(topBlock?.type).toBe(BLOCK_TYPES.scopedRuleCasesStep);
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('reconstructs scoped-rule action stacks in normalized order from canonical workflow patches', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_case_action_order',
      name: 'Case action order',
      steps: [
        {
          id: 'step_case_action_order',
          type: 'scopedRule',
          columnIds: ['col_status'],
          cases: [
            {
              when: call('isEmpty', value()),
              then: {
                value: literal('unknown'),
                format: {
                  fillColor: '#ff0000',
                },
              },
            },
          ],
          defaultPatch: {
            value: call('lower', value()),
            format: {
              fillColor: '#ffeb9c',
            },
          },
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_status'], workflow);
    const [topBlock] = workspace.getTopBlocks(false);
    const ruleCaseBlock = topBlock?.getInputTargetBlock('CASES');
    const firstCaseAction = ruleCaseBlock?.getInputTargetBlock('ACTIONS');
    const defaultAction = topBlock?.getInputTargetBlock('DEFAULT_ACTIONS');

    expect(firstCaseAction?.type).toBe(BLOCK_TYPES.setValueActionItem);
    expect(firstCaseAction?.getNextBlock()?.type).toBe(BLOCK_TYPES.highlightActionItem);
    expect(defaultAction?.type).toBe(BLOCK_TYPES.setValueActionItem);
    expect(defaultAction?.getNextBlock()?.type).toBe(BLOCK_TYPES.highlightActionItem);
  });

  it('wraps long comment text into multiple display lines without truncating content', () => {
    const lines = wrapCommentDisplayLines('Calculate a priority based on status and bonus income for this customer.', 18);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('Calculate a priority');
    expect(lines.join(' ')).toContain('bonus income');
    expect(lines.join(' ')).toContain('customer.');
  });

  it('roundtrips canonical workflows through the authoring model without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_roundtrip',
      name: 'Roundtrip',
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
        {
          id: 'step_derive_display_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_display_name',
            displayName: 'display_name',
          },
          expression: concat(column('col_first_name'), literal(' '), column('col_last_name')),
        },
      ],
    };

    const authored = workflowToAuthoringWorkflow(workflow);
    const roundtrip = authoringWorkflowToWorkflow(authored);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('compiles create-column blank and copy modes to canonical deriveColumn expressions', () => {
    const workspace = createHeadlessWorkflowWorkspace();

    setEditorSchemaColumns([createColumn('col_first_name', 'first_name', 'string')], ['col_first_name']);

    const blankBlock = workspace.newBlock(BLOCK_TYPES.deriveColumnStep);
    blankBlock.setFieldValue('col_notes', 'NEW_COLUMN_ID');
    blankBlock.setFieldValue('notes', 'NEW_DISPLAY_NAME');

    const copyBlock = workspace.newBlock(BLOCK_TYPES.deriveColumnStep);
    copyBlock.setFieldValue('col_first_name_copy', 'NEW_COLUMN_ID');
    copyBlock.setFieldValue('first_name_copy', 'NEW_DISPLAY_NAME');
    copyBlock.setFieldValue('copy', 'CREATE_MODE');
    copyBlock.setFieldValue('col_first_name', 'COPY_COLUMN_ID');

    blankBlock.nextConnection?.connect(copyBlock.previousConnection!);

    const result = workspaceToWorkflow(workspace);

    expect(result.issues).toEqual([]);
    expect(result.workflow?.steps).toEqual([
      expect.objectContaining({
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_notes',
          displayName: 'notes',
        },
        expression: literal(null),
      }),
      expect.objectContaining({
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_first_name_copy',
          displayName: 'first_name_copy',
        },
        expression: column('col_first_name'),
      }),
    ]);
  });

  it('roundtrips scoped rules that mix value() and same-row column() references', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_fill_email_from_customer_id',
      name: 'Fill email from customer id',
      steps: [
        {
          id: 'step_fill_email',
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: coalesce(value(), column('col_customer_id')),
          },
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_email', 'col_customer_id'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.columnExpression);
  });

  it('reconstructs split, first, and last function trees in derive-column blocks', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_derive_initials',
      name: 'Derive initials',
      steps: [
        {
          id: 'step_derive_initials',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_initials',
            displayName: 'initials',
          },
          expression: concat(
            call('first', column('col_first_name')),
            call('first', call('last', call('split', column('col_last_name'), literal(' ')))),
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_first_name', 'col_last_name', 'col_initials'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.splitFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.firstFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.lastFunction);
  });

  it('reconstructs atIndex function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_extract_middle_name',
      name: 'Extract middle name',
      steps: [
        {
          id: 'step_extract_middle_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_middle_name',
            displayName: 'middle_name',
          },
          expression: call('atIndex', call('split', column('col_name'), literal(' ')), literal(1)),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_name', 'col_middle_name'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.atIndexFunction);
  });

  it('reconstructs extractRegex and replaceRegex function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_regex_transform_blocks',
      name: 'Regex transform blocks',
      steps: [
        {
          id: 'step_extract_order_id',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_order_id',
            displayName: 'order_id',
          },
          expression: call('extractRegex', column('col_note'), literal('ORD-\\d+')),
        },
        {
          id: 'step_clean_note',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_note_compact',
            displayName: 'note_compact',
          },
          expression: call('replaceRegex', column('col_note'), literal('\\s+'), literal('_')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_note', 'col_order_id', 'col_note_compact'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.extractRegexFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.replaceRegexFunction);
  });

  it('reconstructs explicit cast function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_cast_roundtrip',
      name: 'Cast roundtrip',
      steps: [
        {
          id: 'step_value_number',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_value_number',
            displayName: 'value_number',
          },
          expression: call('toNumber', column('col_value')),
        },
        {
          id: 'step_value_string',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_value_string',
            displayName: 'value_string',
          },
          expression: call('toString', column('col_value_number')),
        },
        {
          id: 'step_flag_boolean',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_flag_boolean',
            displayName: 'flag_boolean',
          },
          expression: call('toBoolean', column('col_flag')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_value', 'col_value_number', 'col_value_string', 'col_flag', 'col_flag_boolean'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);
    const blockTypes = workspace.getAllBlocks(false).map((block) => block.type);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(blockTypes).toContain(BLOCK_TYPES.toNumberFunction);
    expect(blockTypes).toContain(BLOCK_TYPES.toStringFunction);
    expect(blockTypes).toContain(BLOCK_TYPES.toBooleanFunction);
  });

  it('reconstructs match expression trees with literal, one-of, range, guarded, and wildcard patterns', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_match_roundtrip',
      name: 'Match roundtrip',
      steps: [
        {
          id: 'step_match_status',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_status_label',
            displayName: 'status_label',
          },
          expression: match(
            call('lower', call('trim', column('col_status'))),
            [
              {
                pattern: matchLiteral('active'),
                then: literal('A'),
              },
              {
                pattern: matchOneOf('inactive', 'disabled'),
                when: call('equals', column('col_region'), literal('west')),
                then: literal('I'),
              },
              {
                pattern: matchWildcard(),
                then: literal('other'),
              },
            ],
          ),
        },
        {
          id: 'step_match_priority',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_priority_score',
            displayName: 'priority_score',
          },
          expression: match(
            call('toNumber', column('col_balance')),
            [
              {
                pattern: matchRange({ lt: 0 }),
                then: literal(3),
              },
              {
                pattern: matchRange({ gte: 0, lte: 200 }),
                then: literal(2),
              },
              {
                pattern: matchWildcard(),
                then: literal(1),
              },
            ],
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_status', 'col_region', 'col_balance', 'col_status_label', 'col_priority_score'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);
    const matchBlock = workspace.getAllBlocks(false).find((block) => block.type === BLOCK_TYPES.matchExpression);
    const matchCaseBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.matchCaseItem);
    const oneOfPatternBlock = workspace.getAllBlocks(false).find((block) => block.type === BLOCK_TYPES.matchOneOfPattern);
    const rangePatternBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.matchRangePattern);
    const wildcardPatternBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.matchWildcardPattern);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(matchBlock).toBeTruthy();
    expect(matchBlock?.getInput('SUBJECT')).toBeTruthy();
    expect(matchBlock?.getInput('CASES')).toBeTruthy();
    expect(matchCaseBlocks.length).toBeGreaterThanOrEqual(3);
    expect(oneOfPatternBlock).toBeTruthy();
    expect(oneOfPatternBlock?.getInput('VALUE0')).toBeTruthy();
    expect(oneOfPatternBlock?.getInput('VALUE1')).toBeTruthy();
    expect(rangePatternBlocks).toHaveLength(2);
    expect(wildcardPatternBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it('reconstructs arithmetic and rounding function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_math_roundtrip',
      name: 'Math roundtrip',
      steps: [
        {
          id: 'step_derive_total',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total',
            displayName: 'total',
          },
          expression: call('multiply', column('col_price'), column('col_quantity')),
        },
        {
          id: 'step_derive_total_rounded',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total_rounded',
            displayName: 'total_rounded',
          },
          expression: call('round', column('col_total')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_price', 'col_quantity', 'col_total', 'col_total_rounded'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.arithmeticFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.mathRoundingFunction);
  });

  it('reconstructs date and time function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_date_roundtrip',
      name: 'Date roundtrip',
      steps: [
        {
          id: 'step_signup_year',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_signup_year',
            displayName: 'signup_year',
          },
          expression: call('datePart', column('col_sign_up_date'), literal('year')),
        },
        {
          id: 'step_follow_up_at',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_follow_up_at',
            displayName: 'follow_up_at',
          },
          expression: call('dateAdd', call('now'), literal(7), literal('days')),
        },
        {
          id: 'step_days_since_signup',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_days_since_signup',
            displayName: 'days_since_signup',
          },
          expression: call('dateDiff', call('now'), column('col_sign_up_date'), literal('days')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(
      ['col_sign_up_date', 'col_signup_year', 'col_follow_up_at', 'col_days_since_signup'],
      workflow,
    );
    const roundtrip = workspaceToWorkflow(workspace);
    const blockTypes = workspace.getAllBlocks(false).map((block) => block.type);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(blockTypes).toContain(BLOCK_TYPES.nowFunction);
    expect(blockTypes).toContain(BLOCK_TYPES.datePartFunction);
    expect(blockTypes).toContain(BLOCK_TYPES.dateDiffFunction);
    expect(blockTypes).toContain(BLOCK_TYPES.dateAddFunction);
  });

  it('reconstructs deriveColumn workflows as create-column blank and copy modes when possible', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_create_column_modes',
      name: 'Create column modes',
      steps: [
        {
          id: 'step_create_blank_notes',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_notes',
            displayName: 'notes',
          },
          expression: literal(null),
        },
        {
          id: 'step_copy_first_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_first_name_copy',
            displayName: 'first_name_copy',
          },
          expression: column('col_first_name'),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_first_name', 'col_notes', 'col_first_name_copy'], workflow);
    const [firstBlock] = workspace.getTopBlocks(false);
    const secondBlock = firstBlock?.getNextBlock();
    const roundtrip = workspaceToWorkflow(workspace);

    expect(firstBlock?.type).toBe(BLOCK_TYPES.deriveColumnStep);
    expect(firstBlock?.getFieldValue('CREATE_MODE')).toBe('blank');
    expect(secondBlock?.type).toBe(BLOCK_TYPES.deriveColumnStep);
    expect(secondBlock?.getFieldValue('CREATE_MODE')).toBe('copy');
    expect(secondBlock?.getFieldValue('COPY_COLUMN_ID')).toBe('col_first_name');
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('roundtrips matchesRegex logic expressions through Blockly blocks without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_regex_roundtrip',
      name: 'Regex roundtrip',
      steps: [
        {
          id: 'step_filter_regex',
          type: 'filterRows',
          mode: 'keep',
          condition: call('matchesRegex', column('col_email'), literal('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_email'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.predicateFunction);
  });

  it('roundtrips isEmpty logic expressions through a dedicated unary predicate block', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_is_empty_roundtrip',
      name: 'Is empty roundtrip',
      steps: [
        {
          id: 'step_filter_empty_email',
          type: 'filterRows',
          mode: 'keep',
          condition: call('isEmpty', column('col_email')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_email'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.unaryPredicateFunction);
  });

  it('roundtrips symbolic comparator operators without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_symbolic_comparators',
      name: 'Symbolic comparators',
      steps: [
        {
          id: 'step_filter_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: call(
            'and',
            call('or',
              call('lessThan', column('col_order_total'), literal(100)),
              call('equals', column('col_order_total'), literal(100)),
            ),
            call('not', call('equals', column('col_order_status'), literal('cancelled'))),
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_order_total', 'col_order_status'], workflow);
    const comparisonBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.comparisonFunction);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(comparisonBlocks.map((block) => block.getFieldValue('OPERATOR')).sort()).toEqual(['lte', 'ne']);
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('reconstructs flat multi-argument logical groups as one horizontal block', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_flat_logic_group',
      name: 'Flat logic group',
      steps: [
        {
          id: 'step_filter_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: call(
            'and',
            call('greaterThan', column('col_order_total'), literal(100)),
            call('equals', column('col_order_status'), literal('paid')),
            call('not', call('isEmpty', column('col_customer_id'))),
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_order_total', 'col_order_status', 'col_customer_id'], workflow);
    const logicalBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.logicalBinaryFunction);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(logicalBlocks).toHaveLength(1);
    expect(logicalBlocks[0]?.getFieldValue('OPERATOR')).toBe('and');
    expect(logicalBlocks[0]?.getInput('ITEM0')).toBeTruthy();
    expect(logicalBlocks[0]?.getInput('ITEM1')).toBeTruthy();
    expect(logicalBlocks[0]?.getInput('ITEM2')).toBeTruthy();
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('reconstructs drop-columns steps as a dedicated multi-select table-operation block', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_drop_columns',
      name: 'Drop columns',
      steps: [
        {
          id: 'step_drop_columns',
          type: 'dropColumns',
          columnIds: ['col_notes', 'col_internal_flag'],
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_notes', 'col_internal_flag'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getTopBlocks(false)[0]?.type).toBe(BLOCK_TYPES.dropColumnsStep);
  });

  it('roundtrips example workflows through the block workspace without semantic loss', async () => {
    const exampleDir = path.resolve(process.cwd(), 'examples', 'workflows');
    const exampleFiles = (await readdir(exampleDir))
      .filter((fileName) => fileName.endsWith('.workflow.json'))
      .sort();

    for (const fileName of exampleFiles) {
      const parsed = parseWorkflowJson(await readFile(path.join(exampleDir, fileName), 'utf8'));

      expect(parsed.issues, fileName).toEqual([]);
      expect(parsed.workflow, fileName).not.toBeNull();

      const workflow = parsed.workflow!;
      const workspace = buildWorkspaceFromColumnIds(collectWorkflowColumnIds(workflow), workflow);
      const roundtrip = workspaceToWorkflow(workspace);

      expect(roundtrip.issues, fileName).toEqual([]);
      expect(roundtrip.workflow, fileName).toEqual(workflow);
    }
  }, 15000);

  it('loads read-only preview workflows and roundtrips steps that reference created columns later', () => {
    const table: Table = {
      tableId: 'table_preview',
      sourceName: 'Preview table',
      schema: {
        columns: [createColumn('col_email', 'Email', 'string')],
      },
      rowsById: {
        row_1: {
          rowId: 'row_1',
          cellsByColumnId: {
            col_email: 'alice@example.com',
          },
          stylesByColumnId: {},
        },
      },
      rowOrder: ['row_1'],
      importWarnings: [],
    };
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_ai_preview',
      name: 'AI preview',
      description: 'Preview the applied workflow draft.',
      steps: [
        {
          id: 'step_derive_email_clean',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'email_clean',
            displayName: 'Email clean',
          },
          expression: call('trim', column('col_email')),
        },
        {
          id: 'step_sort_email_clean',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'email_clean',
              direction: 'asc',
            },
          ],
        },
      ],
    };
    const workspace = createHeadlessWorkflowWorkspace();
    const extraColumnIds = collectWorkflowColumnIds(workflow);
    const stepChainTypes: string[] = [];

    setEditorSchemaColumns(table.schema.columns, extraColumnIds);
    workflowToWorkspace(workspace, workflow);
    setEditorSchemaColumns(table.schema.columns, extraColumnIds, projectWorkspaceStepSchemas(workspace, table));

    let block: ReturnType<typeof workspace.getTopBlocks>[number] | undefined = workspace.getTopBlocks(false)[0];

    while (block) {
      stepChainTypes.push(block.type);
      block = block.getNextBlock() ?? undefined;
    }

    expect(stepChainTypes).toEqual([BLOCK_TYPES.deriveColumnStep, BLOCK_TYPES.sortRowsStep]);
    expect(workspaceToWorkflow(workspace)).toEqual({
      workflow,
      issues: [],
    });
  });

  it('keeps validation and execution wired to canonical IR after block serialization', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_run_from_editor',
      name: 'Run from editor',
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
        {
          id: 'step_drop_missing_email',
          type: 'filterRows',
          mode: 'drop',
          condition: call('isEmpty', column('col_email')),
        },
      ],
    };
    const workspace = buildWorkspaceFromTable(table, workflow);
    const validation = validateWorkspaceWorkflow(workspace, table);
    const run = runWorkspaceWorkflow(workspace, table);
    const expected = executeWorkflow(workflow, table);

    expect(validation.editorIssues).toEqual([]);
    expect(validation.validationIssues).toEqual([]);
    expect(run.editorIssues).toEqual([]);
    expect(run.validationIssues).toEqual([]);
    expect(run.executionResult).toEqual(expected);
  });

  it('rejects non-canonical workflow JSON versions on import', () => {
    const unsupportedJson = JSON.stringify({
      version: 1,
      workflowId: 'wf_unsupported_fill',
      name: 'Unsupported fill',
      steps: [
        {
          id: 'step_fill_status',
          type: 'fillEmpty',
          target: {
            kind: 'columns',
            columnIds: ['col_status'],
          },
          value: 'unknown',
          treatWhitespaceAsEmpty: true,
        },
      ],
    });

    const parsed = parseWorkflowJson(unsupportedJson);

    expect(parsed.workflow).toBeNull();
    expect(parsed.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'schema.const',
        }),
      ]),
    );
  }, 15000);

  it('surfaces invalid editor blocks clearly when required inputs are missing', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const block = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);

    block.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');

    const result = workspaceToWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual([
      {
        code: 'missingRuleCases',
        message: `Block '${BLOCK_TYPES.scopedRuleCasesStep}' must define at least one case or a default patch.`,
        blockId: block.id,
        blockType: BLOCK_TYPES.scopedRuleCasesStep,
      },
    ]);
  });

  it('reports multiple invalid action inputs in a scoped rule alongside floating orphan expression blocks', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const ruleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem);
    const whenBlock = workspace.newBlock(BLOCK_TYPES.unaryPredicateFunction);
    const valueBlock = workspace.newBlock(BLOCK_TYPES.currentValueExpression);
    const setValueActionBlock = workspace.newBlock(BLOCK_TYPES.setValueActionItem);
    const highlightActionBlock = workspace.newBlock(BLOCK_TYPES.highlightActionItem);
    const orphanComparisonBlock = workspace.newBlock(BLOCK_TYPES.comparisonFunction);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');
    whenBlock.setFieldValue('isEmpty', 'OPERATOR');

    scopedRuleBlock.getInput('CASES')?.connection?.connect(ruleCaseBlock.previousConnection!);
    ruleCaseBlock.getInput('WHEN')?.connection?.connect(whenBlock.outputConnection!);
    whenBlock.getInput('INPUT')?.connection?.connect(valueBlock.outputConnection!);
    ruleCaseBlock.getInput('ACTIONS')?.connection?.connect(setValueActionBlock.previousConnection!);
    setValueActionBlock.nextConnection?.connect(highlightActionBlock.previousConnection!);

    const result = workspaceToWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: 'missingInput',
          message: `Block '${BLOCK_TYPES.setValueActionItem}' is missing required input 'VALUE'.`,
          blockId: setValueActionBlock.id,
          blockType: BLOCK_TYPES.setValueActionItem,
        },
        {
          code: 'missingInput',
          message: `Block '${BLOCK_TYPES.highlightActionItem}' is missing required input 'COLOR'.`,
          blockId: highlightActionBlock.id,
          blockType: BLOCK_TYPES.highlightActionItem,
        },
        {
          code: 'orphanBlock',
          message: `Block '${BLOCK_TYPES.comparisonFunction}' is not connected to a workflow step.`,
          blockId: orphanComparisonBlock.id,
          blockType: BLOCK_TYPES.comparisonFunction,
        },
      ]),
    );
  });

  it('still roundtrips canonical workflow JSON without editor-only data leaking into persistence', () => {
    const workflow = buildAllStepsWorkflow();
    const json = workflowToJson(workflow);
    const parsed = parseWorkflowJson(json);

    expect(parsed.issues).toEqual([]);
    expect(parsed.workflow).toEqual(workflow);
    expect(json).toContain('"version": 2');
    expect(json).toContain('"type": "scopedRule"');
    expect(json).toContain('"name": "lower"');
    expect(json).not.toContain('sourceBlockId');
  });

  it('uses expression-based logic blocks instead of legacy condition blocks', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const transformBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const comparisonBlock = workspace.newBlock(BLOCK_TYPES.comparisonFunction);
    const predicateBlock = workspace.newBlock(BLOCK_TYPES.predicateFunction);
    const unaryPredicateBlock = workspace.newBlock(BLOCK_TYPES.unaryPredicateFunction);
    const logicalBlock = workspace.newBlock(BLOCK_TYPES.logicalBinaryFunction);

    expect(transformBlock.getInput('ROW_CONDITION')?.connection?.getCheck()).toEqual(['EXPRESSION']);
    expect(predicateBlock.outputConnection?.getCheck()).toEqual(['EXPRESSION']);
    expect(unaryPredicateBlock.outputConnection?.getCheck()).toEqual(['EXPRESSION']);
    expect(comparisonBlock.getFieldValue('OPERATOR')).toBe('eq');
    expect(predicateBlock.getFieldValue('OPERATOR')).toBe('contains');
    expect(unaryPredicateBlock.getFieldValue('OPERATOR')).toBe('isEmpty');
    expect(logicalBlock.getFieldValue('OPERATOR')).toBe('and');
    expect(comparisonBlock.inputsInline).toBe(true);
    expect(predicateBlock.inputsInline).toBe(true);
    expect(unaryPredicateBlock.inputsInline).toBe(true);
    expect(logicalBlock.inputsInline).toBe(false);
    expect(logicalBlock.getInput('HEADER')).toBeTruthy();
    expect(logicalBlock.getField('ADD_ITEM')).toBeTruthy();
    expect(logicalBlock.getField('REMOVE_ITEM')).toBeTruthy();
    expect(predicateBlock.getInput('FIRST')).toBeTruthy();
    expect(predicateBlock.getInput('SECOND')).toBeTruthy();
    expect(unaryPredicateBlock.getInput('INPUT')).toBeTruthy();
    expect(logicalBlock.getInput('ITEM0')).toBeTruthy();
    expect(logicalBlock.getInput('ITEM1')).toBeTruthy();
  });

  it('lays out scoped-rule cases and defaults with nested cell-action statements', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep) as {
      getInput: (name: string) => { connection?: { getCheck: () => string[] | null } | null } | null;
    };
    const ruleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem) as {
      inputList: Array<{ name: string; fieldRow?: Array<{ getText?: () => string }> }>;
      getInput: (name: string) => { connection?: { getCheck: () => string[] | null } | null } | null;
    };
    const setValueActionBlock = workspace.newBlock(BLOCK_TYPES.setValueActionItem) as {
      getInput: (name: string) => { connection?: { getCheck: () => string[] | null } | null } | null;
    };
    const highlightActionBlock = workspace.newBlock(BLOCK_TYPES.highlightActionItem) as {
      getInput: (name: string) => { connection?: { getCheck: () => string[] | null } | null } | null;
    };

    expect(ruleCaseBlock.inputList.map((input) => input.name)).toEqual(['WHEN', 'ACTIONS']);
    expect(ruleCaseBlock.inputList[0]?.fieldRow?.[0]?.getText?.()).toBe('case: when');
    expect(ruleCaseBlock.inputList[1]?.fieldRow?.[0]?.getText?.()).toBe('do');
    expect(ruleCaseBlock.getInput('ACTIONS')?.connection?.getCheck()).toEqual(['CELL_ACTION_ITEM']);
    expect(scopedRuleBlock.getInput('DEFAULT_ACTIONS')?.connection?.getCheck()).toEqual(['CELL_ACTION_ITEM']);
    expect(setValueActionBlock.getInput('VALUE')?.connection?.getCheck()).toEqual(['EXPRESSION']);
    expect(highlightActionBlock.getInput('COLOR')?.connection?.getCheck()).toEqual(['COLOR_LITERAL']);
  });

  it('compiles rule-case value actions from nested set-value blocks', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const ruleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem);
    const setValueActionBlock = workspace.newBlock(BLOCK_TYPES.setValueActionItem);
    const valueBlock = workspace.newBlock(BLOCK_TYPES.literalString);
    const whenBlock = workspace.newBlock(BLOCK_TYPES.literalBoolean);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');
    valueBlock.setFieldValue('fallback@example.com', 'VALUE');
    whenBlock.setFieldValue('true', 'VALUE');

    scopedRuleBlock.getInput('CASES')?.connection?.connect(ruleCaseBlock.previousConnection!);
    ruleCaseBlock.getInput('WHEN')?.connection?.connect(whenBlock.outputConnection!);
    ruleCaseBlock.getInput('ACTIONS')?.connection?.connect(setValueActionBlock.previousConnection!);
    setValueActionBlock.getInput('VALUE')?.connection?.connect(valueBlock.outputConnection!);

    const result = workspaceToAuthoringWorkflow(workspace);
    const step = result.workflow?.steps[0];

    if (!step || step.kind !== 'scopedRule') {
      throw new Error('Expected a scoped rule authoring step.');
    }

    expect(result.issues).toEqual([]);
    expect(step.cases[0]).toEqual({
      when: { kind: 'literal', value: true },
      then: {
        valueEnabled: true,
        value: { kind: 'literal', value: 'fallback@example.com' },
        formatEnabled: false,
      },
    });
  });

  it('compiles rule-case highlight colors from nested highlight action blocks', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const ruleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem);
    const highlightActionBlock = workspace.newBlock(BLOCK_TYPES.highlightActionItem);
    const colorBlock = workspace.newBlock(BLOCK_TYPES.literalColor);
    const whenBlock = workspace.newBlock(BLOCK_TYPES.literalBoolean);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');
    colorBlock.setFieldValue('#ff2ccc', 'VALUE');
    whenBlock.setFieldValue('true', 'VALUE');

    scopedRuleBlock.getInput('CASES')?.connection?.connect(ruleCaseBlock.previousConnection!);
    ruleCaseBlock.getInput('WHEN')?.connection?.connect(whenBlock.outputConnection!);
    ruleCaseBlock.getInput('ACTIONS')?.connection?.connect(highlightActionBlock.previousConnection!);
    highlightActionBlock.getInput('COLOR')?.connection?.connect(colorBlock.outputConnection!);

    const result = workspaceToAuthoringWorkflow(workspace);
    const step = result.workflow?.steps[0];

    if (!step || step.kind !== 'scopedRule') {
      throw new Error('Expected a scoped rule authoring step.');
    }

    expect(result.issues).toEqual([]);
    expect(step.cases[0]).toEqual({
      when: { kind: 'literal', value: true },
      then: {
        valueEnabled: false,
        formatEnabled: true,
        fillColor: '#ff2ccc',
      },
    });
  });

  it('drops empty rule-case action stacks when another action keeps the scoped rule effective', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const emptyRuleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem);
    const whenBlock = workspace.newBlock(BLOCK_TYPES.literalBoolean);
    const setValueActionBlock = workspace.newBlock(BLOCK_TYPES.setValueActionItem);
    const valueBlock = workspace.newBlock(BLOCK_TYPES.literalString);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');
    whenBlock.setFieldValue('true', 'VALUE');
    valueBlock.setFieldValue('fallback@example.com', 'VALUE');

    scopedRuleBlock.getInput('CASES')?.connection?.connect(emptyRuleCaseBlock.previousConnection!);
    emptyRuleCaseBlock.getInput('WHEN')?.connection?.connect(whenBlock.outputConnection!);
    scopedRuleBlock.getInput('DEFAULT_ACTIONS')?.connection?.connect(setValueActionBlock.previousConnection!);
    setValueActionBlock.getInput('VALUE')?.connection?.connect(valueBlock.outputConnection!);

    const result = workspaceToWorkflow(workspace);

    expect(result.issues).toEqual([]);
    expect(result.workflow?.steps[0]).toEqual({
      id: 'step_scoped_rule_1',
      type: 'scopedRule',
      columnIds: ['col_email'],
      defaultPatch: {
        value: { kind: 'literal', value: 'fallback@example.com' },
      },
    });
  });

  it('treats empty rule-case action stacks as no-ops until the step-level validation runs', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const ruleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem);
    const whenBlock = workspace.newBlock(BLOCK_TYPES.literalBoolean);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');
    whenBlock.setFieldValue('true', 'VALUE');

    scopedRuleBlock.getInput('CASES')?.connection?.connect(ruleCaseBlock.previousConnection!);
    ruleCaseBlock.getInput('WHEN')?.connection?.connect(whenBlock.outputConnection!);

    const result = workspaceToAuthoringWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual([
      {
        code: 'missingRuleCases',
        message: `Block '${BLOCK_TYPES.scopedRuleCasesStep}' must define at least one case or a default patch.`,
        blockId: scopedRuleBlock.id,
        blockType: BLOCK_TYPES.scopedRuleCasesStep,
      },
    ]);
  });

  it('surfaces duplicate cell actions within a single rule case', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);
    const ruleCaseBlock = workspace.newBlock(BLOCK_TYPES.ruleCaseItem);
    const whenBlock = workspace.newBlock(BLOCK_TYPES.literalBoolean);
    const firstHighlightBlock = workspace.newBlock(BLOCK_TYPES.highlightActionItem);
    const secondHighlightBlock = workspace.newBlock(BLOCK_TYPES.highlightActionItem);
    const firstColorBlock = workspace.newBlock(BLOCK_TYPES.literalColor);
    const secondColorBlock = workspace.newBlock(BLOCK_TYPES.literalColor);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');
    whenBlock.setFieldValue('true', 'VALUE');
    firstColorBlock.setFieldValue('#ff2ccc', 'VALUE');
    secondColorBlock.setFieldValue('#ffeb9c', 'VALUE');

    scopedRuleBlock.getInput('CASES')?.connection?.connect(ruleCaseBlock.previousConnection!);
    ruleCaseBlock.getInput('WHEN')?.connection?.connect(whenBlock.outputConnection!);
    ruleCaseBlock.getInput('ACTIONS')?.connection?.connect(firstHighlightBlock.previousConnection!);
    firstHighlightBlock.nextConnection?.connect(secondHighlightBlock.previousConnection!);
    firstHighlightBlock.getInput('COLOR')?.connection?.connect(firstColorBlock.outputConnection!);
    secondHighlightBlock.getInput('COLOR')?.connection?.connect(secondColorBlock.outputConnection!);

    const result = workspaceToAuthoringWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual([
      {
        code: 'duplicateCellAction',
        message: `Block '${BLOCK_TYPES.ruleCaseItem}' cannot define more than one 'highlight' action.`,
        blockId: secondHighlightBlock.id,
        blockType: BLOCK_TYPES.highlightActionItem,
      },
    ]);
  });

  it('treats empty scoped-rule default action stacks as no default patch', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const scopedRuleBlock = workspace.newBlock(BLOCK_TYPES.scopedRuleCasesStep);

    scopedRuleBlock.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');

    const result = workspaceToAuthoringWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual([
      {
        code: 'missingRuleCases',
        message: `Block '${BLOCK_TYPES.scopedRuleCasesStep}' must define at least one case or a default patch.`,
        blockId: scopedRuleBlock.id,
        blockType: BLOCK_TYPES.scopedRuleCasesStep,
      },
    ]);
  });

  it('exposes schema-aware explicit column IDs for multi-select fields', async () => {
    const table = await readFixtureTable('messy-customers.csv');

    setEditorSchemaColumns(table.schema.columns);

    expect(getSelectableColumns().map((entry) => entry.columnId)).toEqual(table.schema.columns.map((column) => column.columnId));
  });

  it('projects created columns into later step selectors based on authored step order', () => {
    const baseColumns = [createColumn('col_email', 'Email', 'string')];
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_modify_copied_column',
      name: 'Modify copied column',
      steps: [
        {
          id: 'step_copy_email',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'email_safe',
            displayName: 'Email (safe)',
          },
          expression: column('col_email'),
        },
        {
          id: 'step_fill_email_safe',
          type: 'scopedRule',
          columnIds: ['email_safe'],
          defaultPatch: {
            value: coalesce(value(), literal('NA')),
          },
        },
      ],
    };
    const workspace = buildWorkspaceFromColumnIds(['col_email', 'email_safe'], workflow, baseColumns);
    const deriveBlock = workspace.getTopBlocks(false)[0];
    const transformBlock = deriveBlock?.getNextBlock();
    const schemaByBlockId = projectWorkspaceStepSchemas(workspace, {
      tableId: 'table_test',
      sourceName: 'test.csv',
      schema: {
        columns: baseColumns,
      },
      rowsById: {},
      rowOrder: [],
      importWarnings: [],
    });

    setEditorSchemaColumns(baseColumns, ['col_email', 'email_safe'], schemaByBlockId);

    expect(transformBlock?.type).toBe(BLOCK_TYPES.scopedRuleCasesStep);
    expect(getSchemaColumnOptions(transformBlock?.id)).toContainEqual(['Email (safe) [email_safe]', 'email_safe']);
    expect(getSelectableColumns(transformBlock?.id).map((entry) => entry.columnId)).toContain('email_safe');
    expect(transformBlock?.getField('COLUMN_IDS')?.getText()).toContain('Email (safe)');
  });

  it('exposes bulk type selections for schema-aware multi-select fields', () => {
    setEditorSchemaColumns([
      createColumn('col_email', 'email', 'string'),
      createColumn('col_city', 'city', 'string'),
      createColumn('col_order_total', 'order_total', 'number'),
      createColumn('col_is_active', 'is_active', 'boolean'),
      createColumn('col_ordered_at', 'ordered_at', 'datetime'),
    ]);

    expect(getSelectableColumnTypeGroups()).toEqual([
      {
        logicalType: 'string',
        label: 'All string columns',
        columnIds: ['col_email', 'col_city'],
      },
      {
        logicalType: 'number',
        label: 'All numeric columns',
        columnIds: ['col_order_total'],
      },
      {
        logicalType: 'boolean',
        label: 'All boolean columns',
        columnIds: ['col_is_active'],
      },
      {
        logicalType: 'datetime',
        label: 'All datetime columns',
        columnIds: ['col_ordered_at'],
      },
    ]);
    expect(formatColumnSelectionSummary(['col_email', 'col_city'])).toBe('All string columns (2)');
  });
});

function buildWorkspaceFromTable(table: Table, workflow: Workflow) {
  return buildWorkspaceFromColumnIds(
    [
      ...table.schema.columns.map((column) => column.columnId),
      ...collectWorkflowColumnIds(workflow),
    ],
    workflow,
    table.schema.columns,
  );
}

function buildWorkspaceFromColumnIds(columnIds: string[], workflow: Workflow, columns: Table['schema']['columns'] = []) {
  const workspace = createHeadlessWorkflowWorkspace();

  setEditorSchemaColumns(columns, columnIds);
  workflowToWorkspace(workspace, workflow);

  return workspace;
}

function buildAllStepsWorkflow(): Workflow {
  return {
    version: 2,
    workflowId: 'wf_all_steps',
    name: 'All steps',
    description: 'Covers every current step type.',
    steps: [
      {
        id: 'step_note_cleanup',
        type: 'comment',
        text: 'Normalize and highlight important fields before filtering.',
      },
      {
        id: 'step_fill_status',
        type: 'scopedRule',
        columnIds: ['col_status'],
        defaultPatch: {
          value: coalesce(value(), literal('unknown')),
        },
      },
      {
        id: 'step_highlight_vip_status',
        type: 'scopedRule',
        columnIds: ['col_status'],
        rowCondition: call('equals', column('col_vip'), literal(true)),
        defaultPatch: {
          format: {
            fillColor: '#ffeb9c',
          },
        },
      },
      {
        id: 'step_normalize_text',
        type: 'scopedRule',
        columnIds: ['col_email', 'col_city'],
        defaultPatch: {
          value: call('lower', call('collapseWhitespace', call('trim', value()))),
        },
      },
      {
        id: 'step_drop_columns',
        type: 'dropColumns',
        columnIds: ['col_internal_notes'],
      },
      {
        id: 'step_rename_customer_id',
        type: 'renameColumn',
        columnId: 'col_customer_id',
        newDisplayName: 'external_customer_id',
      },
      {
        id: 'step_derive_location',
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_display_location',
          displayName: 'display_location',
        },
        expression: concat(
          column('col_city'),
          literal(', '),
          coalesce(column('col_state'), literal('unknown')),
        ),
      },
      {
        id: 'step_filter_rows',
        type: 'filterRows',
        mode: 'keep',
        condition: call(
          'and',
          call('not', call('isEmpty', column('col_email'))),
          call('contains', column('col_email'), literal('@')),
        ),
      },
      {
        id: 'step_split_name',
        type: 'splitColumn',
        columnId: 'col_full_name',
        delimiter: ' ',
        outputColumns: [
          {
            columnId: 'col_first_name',
            displayName: 'first_name',
          },
          {
            columnId: 'col_last_name',
            displayName: 'last_name',
          },
        ],
      },
      {
        id: 'step_combine_columns',
        type: 'combineColumns',
        columnIds: ['col_city', 'col_state'],
        separator: ', ',
        newColumn: {
          columnId: 'col_location',
          displayName: 'location',
        },
      },
      {
        id: 'step_dedupe_rows',
        type: 'deduplicateRows',
        columnIds: ['col_email'],
      },
      {
        id: 'step_sort_rows',
        type: 'sortRows',
        sorts: [
          {
            columnId: 'col_signup_date',
            direction: 'desc',
          },
          {
            columnId: 'col_full_name',
            direction: 'asc',
          },
        ],
      },
    ],
  };
}

async function readFixtureTable(fileName: string): Promise<Table> {
  const fixturePath = path.resolve(process.cwd(), 'fixtures', fileName);
  const workbook = importCsvWorkbook(fileName, await readFile(fixturePath, 'utf8'));
  const table = getActiveTable(workbook);

  if (!table) {
    throw new Error(`Expected active table for fixture '${fileName}'.`);
  }

  return table;
}

function value(): WorkflowExpression {
  return { kind: 'value' };
}

function literal(cellValue: string | number | boolean | null): WorkflowExpression {
  return {
    kind: 'literal',
    value: cellValue,
  };
}

function column(columnId: string): WorkflowExpression {
  return {
    kind: 'column',
    columnId,
  };
}

type MatchCase = Extract<WorkflowExpression, { kind: 'match' }>['cases'][number];
type MatchPattern = MatchCase['pattern'];

function call(
  name:
    | 'now'
    | 'datePart'
    | 'dateDiff'
    | 'dateAdd'
    | 'trim'
    | 'lower'
    | 'upper'
    | 'toNumber'
    | 'toString'
    | 'toBoolean'
    | 'collapseWhitespace'
    | 'substring'
    | 'replace'
    | 'extractRegex'
    | 'replaceRegex'
    | 'split'
    | 'atIndex'
    | 'round'
    | 'floor'
    | 'ceil'
    | 'abs'
    | 'add'
    | 'subtract'
    | 'multiply'
    | 'divide'
    | 'modulo'
    | 'first'
    | 'last'
    | 'coalesce'
    | 'concat'
    | 'equals'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'matchesRegex'
    | 'greaterThan'
    | 'lessThan'
    | 'and'
    | 'or'
    | 'not'
    | 'isEmpty',
  ...args: WorkflowExpression[]
): WorkflowExpression {
  return {
    kind: 'call',
    name,
    args,
  };
}

function match(subject: WorkflowExpression, cases: MatchCase[]): WorkflowExpression {
  return {
    kind: 'match',
    subject,
    cases,
  };
}

function matchLiteral(value: string | number | boolean | null): MatchPattern {
  return {
    kind: 'literal',
    value,
  };
}

function matchOneOf(...values: Array<string | number | boolean | null>): MatchPattern {
  return {
    kind: 'oneOf',
    values,
  };
}

function matchRange(bounds: {
  gt?: string | number | boolean;
  gte?: string | number | boolean;
  lt?: string | number | boolean;
  lte?: string | number | boolean;
}): MatchPattern {
  return {
    kind: 'range',
    ...bounds,
  };
}

function matchWildcard(): MatchPattern {
  return {
    kind: 'wildcard',
  };
}

function coalesce(first: WorkflowExpression, second: WorkflowExpression): WorkflowExpression {
  return call('coalesce', first, second);
}

function concat(...args: WorkflowExpression[]): WorkflowExpression {
  return call('concat', ...args);
}

function createColumn(columnId: string, displayName: string, logicalType: Table['schema']['columns'][number]['logicalType']): Table['schema']['columns'][number] {
  return {
    columnId,
    displayName,
    logicalType,
    nullable: true,
    sourceIndex: 0,
    missingCount: 0,
  };
}
