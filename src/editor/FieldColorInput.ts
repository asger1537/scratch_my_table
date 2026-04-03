import * as Blockly from 'blockly';

import { getReadableTextColor, isValidFillColor, normalizeFillColor } from '../domain/model';

export const DEFAULT_COLOR = '#ffeb9c';
export const RECENT_FILL_COLOR_STORAGE_KEY = 'scratch_my_table.recent_fill_colors';
export const MAX_RECENT_FILL_COLORS = 8;
export const FILL_COLOR_CHOICES = [
  { label: 'White', color: '#FFFFFF' },
  { label: 'Green', color: '#C6EFCE' },
  { label: 'Yellow', color: '#FFEB9C' },
  { label: 'Orange', color: '#F4B183' },
  { label: 'Red', color: '#FFC7CE' },
  { label: 'Purple', color: '#D9C2E9' },
  { label: 'Blue', color: '#BDD7EE' },
] as const;

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

    const initialColor = normalizeEditorColor(this.getValue() ?? DEFAULT_COLOR);
    let selectedColor = initialColor;
    let recentColors = readRecentFillColors();

    const currentPreview = document.createElement('div');
    currentPreview.className = 'blockly-color-input__current';

    const currentSwatch = document.createElement('div');
    currentSwatch.className = 'blockly-color-input__current-swatch';
    currentSwatch.style.backgroundColor = initialColor;

    const currentMeta = document.createElement('div');
    currentMeta.className = 'blockly-color-input__current-meta';

    const currentLabel = document.createElement('div');
    currentLabel.className = 'blockly-color-input__current-label';
    currentLabel.textContent = 'Selected color';

    const valueLabel = document.createElement('div');
    valueLabel.className = 'blockly-color-input__value';
    valueLabel.textContent = initialColor.toLocaleUpperCase();

    currentMeta.append(currentLabel, valueLabel);
    currentPreview.append(currentSwatch, currentMeta);

    const paletteButtons: HTMLButtonElement[] = [];
    const recentSection = document.createElement('div');
    recentSection.className = 'blockly-color-input__section';
    const recentSectionLabel = document.createElement('div');
    recentSectionLabel.className = 'blockly-color-input__section-label';
    recentSectionLabel.textContent = 'Recently used';
    const recentGrid = document.createElement('div');
    recentGrid.className = 'blockly-color-input__recent-grid';
    recentSection.append(recentSectionLabel, recentGrid);

    const customRow = document.createElement('label');
    customRow.className = 'blockly-color-input__custom';

    const customLabel = document.createElement('span');
    customLabel.className = 'blockly-color-input__custom-label';
    customLabel.textContent = 'Custom';

    const customPicker = document.createElement('input');
    customPicker.className = 'blockly-color-input__picker';
    customPicker.type = 'color';
    customPicker.value = initialColor;

    const syncSelectionState = (selectedColor: string) => {
      paletteButtons.forEach((button) => {
        button.classList.toggle('blockly-color-input__choice--selected', button.dataset.color === selectedColor);
      });
    };

    const renderRecentColors = (selectedColor: string) => {
      recentGrid.replaceChildren();

      if (recentColors.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'blockly-color-input__recent-empty';
        emptyState.textContent = 'No recent colors yet.';
        recentGrid.append(emptyState);
        return;
      }

      recentColors.forEach((color) => {
        recentGrid.append(
          createColorButton({
            document,
            color,
            label: color.toLocaleUpperCase(),
            variant: 'recent',
            selected: color === selectedColor,
            onSelect: () => {
              applyColor(color);
            },
          }),
        );
      });
    };

    const applyColor = (nextColor: string) => {
      const normalized = normalizeEditorColor(nextColor);
      selectedColor = normalized;
      customPicker.value = normalized;
      currentSwatch.style.backgroundColor = normalized;
      valueLabel.textContent = normalized.toLocaleUpperCase();
      syncSelectionState(normalized);
      renderRecentColors(normalized);
      this.setValue(normalized);
    };

    wrapper.append(currentPreview, recentSection);

    wrapper.append(
      createPaletteSection(document, 'Colors', FILL_COLOR_CHOICES, initialColor, paletteButtons, (color) => {
        applyColor(color);
      }),
    );

    customPicker.addEventListener('input', () => {
      applyColor(customPicker.value);
    });

    customRow.append(customLabel, customPicker);
    wrapper.append(customRow);

    renderRecentColors(initialColor);
    contentDiv.append(wrapper);

    Blockly.DropDownDiv.setColour('#fffaf3', '#d7b98c');
    Blockly.DropDownDiv.showPositionedByField(this, () => {
      if (selectedColor !== initialColor) {
        recentColors = pushRecentFillColor(recentColors, selectedColor);
        writeRecentFillColors(recentColors);
      }
      wrapper.remove();
    });

    setTimeout(() => customPicker.focus(), 0);
  }
}

function createPaletteSection(
  documentRef: Document,
  title: string,
  choices: ReadonlyArray<{ label: string; color: string }>,
  currentColor: string,
  paletteButtons: HTMLButtonElement[],
  onSelect: (color: string) => void,
) {
  const section = documentRef.createElement('div');
  section.className = 'blockly-color-input__section';

  const sectionLabel = documentRef.createElement('div');
  sectionLabel.className = 'blockly-color-input__section-label';
  sectionLabel.textContent = title;

  const grid = documentRef.createElement('div');
  grid.className = 'blockly-color-input__choice-grid';

  choices.forEach((choice) => {
    const normalizedColor = normalizeEditorColor(choice.color);
    const button = createColorButton({
      document: documentRef,
      color: normalizedColor,
      label: choice.label,
      variant: 'palette',
      selected: normalizedColor === currentColor,
      onSelect: () => {
        onSelect(normalizedColor);
      },
    });
    paletteButtons.push(button);
    grid.append(button);
  });

  section.append(sectionLabel, grid);
  return section;
}

function createColorButton({
  document,
  color,
  label,
  variant,
  selected,
  onSelect,
}: {
  document: Document;
  color: string;
  label: string;
  variant: 'palette' | 'recent';
  selected: boolean;
  onSelect: () => void;
}) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = `blockly-color-input__choice blockly-color-input__choice--${variant}`;
  button.dataset.color = color;
  button.title = label;
  button.setAttribute('aria-label', `Select ${label} (${color})`);
  button.style.backgroundColor = color;
  button.style.color = getReadableTextColor(color);
  button.classList.toggle('blockly-color-input__choice--selected', selected);
  button.addEventListener('click', onSelect);

  return button;
}

export function pushRecentFillColor(recentColors: string[], nextColor: string) {
  const normalized = normalizeEditorColor(nextColor);

  return [normalized, ...recentColors.filter((color) => color !== normalized)].slice(0, MAX_RECENT_FILL_COLORS);
}

function readRecentFillColors() {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(RECENT_FILL_COLOR_STORAGE_KEY);

    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => normalizeEditorColor(value))
      .slice(0, MAX_RECENT_FILL_COLORS);
  } catch {
    return [];
  }
}

function writeRecentFillColors(recentColors: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(RECENT_FILL_COLOR_STORAGE_KEY, JSON.stringify(recentColors));
  } catch {
    // Ignore storage write failures so the picker stays usable in restricted contexts.
  }
}

function normalizeEditorColor(value: string) {
  return isValidFillColor(value) ? normalizeFillColor(value) : DEFAULT_COLOR;
}
