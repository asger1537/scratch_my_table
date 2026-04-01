import * as Blockly from 'blockly';

import { getReadableTextColor, isValidFillColor, normalizeFillColor } from '../domain/model';

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

  protected override render_() {
    if (!this.textElement_) {
      return;
    }

    const textElement = this.getTextElement();
    const constants = this.getConstants();

    if (!constants) {
      return;
    }

    const value = this.getText();
    const fillColor = normalizeEditorColor(this.getValue() ?? DEFAULT_COLOR);
    const textColor = getReadableTextColor(fillColor);
    const xPadding = this.isFullBlockField() ? 0 : constants.FIELD_BORDER_RECT_X_PADDING;
    const yPadding = this.isFullBlockField() ? 0 : constants.FIELD_BORDER_RECT_Y_PADDING;

    textElement.textContent = value;
    textElement.setAttribute('text-anchor', 'start');
    textElement.setAttribute('x', String(xPadding));
    textElement.setAttribute('y', String(yPadding + constants.FIELD_TEXT_BASELINE));
    textElement.style.fill = textColor;

    const textWidth = Blockly.utils.dom.getFastTextWidth(
      textElement,
      constants.FIELD_TEXT_FONTSIZE,
      constants.FIELD_TEXT_FONTWEIGHT,
      constants.FIELD_TEXT_FONTFAMILY,
    );
    const width = xPadding + textWidth + xPadding;
    const height = Math.max(constants.FIELD_BORDER_RECT_HEIGHT, constants.FIELD_TEXT_HEIGHT + (yPadding * 2));

    if (this.borderRect_) {
      this.borderRect_.style.fill = fillColor;
      this.borderRect_.style.fillOpacity = '1';
      this.borderRect_.style.stroke = textColor;
      this.borderRect_.style.strokeOpacity = '0.22';
      this.borderRect_.style.strokeWidth = '1';
    }

    this.size_ = new Blockly.utils.Size(width, height);
    this.positionBorderRect_();
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
