import * as Blockly from 'blockly';

import { isValidFillColor, normalizeFillColor } from '../domain/model';

const DEFAULT_COLOR = '#fff2cc';

export class FieldColorInput extends Blockly.Field<string | undefined> {
  override EDITABLE = true;
  override SERIALIZABLE = true;

  constructor(value = DEFAULT_COLOR, validator?: Blockly.FieldValidator<string | undefined> | null) {
    super(Blockly.Field.SKIP_SETUP);
    this.setValue(normalizeEditorColor(value), false);

    if (validator) {
      this.setValidator(validator);
    }
  }

  protected override initView() {
    super.initView();

    if (!this.clickTarget_) {
      this.clickTarget_ = this.getSvgRoot();
    }
  }

  protected override doClassValidation_(newValue?: string) {
    return normalizeEditorColor(newValue ?? DEFAULT_COLOR);
  }

  protected override getText_() {
    return (this.getValue() ?? DEFAULT_COLOR).toLocaleUpperCase();
  }

  protected override showEditor_() {
    if (!this.isCurrentlyEditable() || typeof document === 'undefined') {
      return;
    }

    Blockly.DropDownDiv.hideIfOwner(this, true);
    Blockly.DropDownDiv.clearContent();
    const contentDiv = Blockly.DropDownDiv.getContentDiv();

    const wrapper = document.createElement('div');
    wrapper.className = 'blockly-color-input';
    const stopPropagation = (event: Event) => event.stopPropagation();
    wrapper.addEventListener('mousedown', stopPropagation);
    wrapper.addEventListener('pointerdown', stopPropagation);
    wrapper.addEventListener('click', stopPropagation);

    const picker = document.createElement('input');
    picker.className = 'blockly-color-input__picker';
    picker.type = 'color';
    picker.value = normalizeEditorColor(this.getValue() ?? DEFAULT_COLOR);

    const valueLabel = document.createElement('div');
    valueLabel.className = 'blockly-color-input__value';
    valueLabel.textContent = picker.value.toLocaleUpperCase();

    const applyColor = (nextColor: string) => {
      const normalized = normalizeEditorColor(nextColor);
      picker.value = normalized;
      valueLabel.textContent = normalized.toLocaleUpperCase();
      this.setValue(normalized);
    };

    picker.addEventListener('input', () => {
      applyColor(picker.value);
    });

    wrapper.append(picker, valueLabel);
    contentDiv.append(wrapper);

    Blockly.DropDownDiv.setColour('#fffaf3', '#d7b98c');
    Blockly.DropDownDiv.showPositionedByField(this, () => {
      wrapper.remove();
    });

    setTimeout(() => picker.focus(), 0);
  }
}

function normalizeEditorColor(value: string) {
  return isValidFillColor(value) ? normalizeFillColor(value) : DEFAULT_COLOR;
}
