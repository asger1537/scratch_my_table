import * as Blockly from 'blockly';

type SearchDropdownOption = {
  label: string;
  value: string;
  searchText?: string;
};

export class FieldSearchDropdown extends Blockly.Field<string | undefined> {
  override EDITABLE = true;
  override SERIALIZABLE = true;

  private options: SearchDropdownOption[] = [];

  constructor(value: string, options: SearchDropdownOption[], validator?: Blockly.FieldValidator<string | undefined> | null) {
    super(Blockly.Field.SKIP_SETUP);
    this.options = options.map((option) => ({
      ...option,
      searchText: (option.searchText ?? `${option.label} ${option.value}`).toLocaleLowerCase(),
    }));
    this.setValue(value, false);

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
    if (!this.options || this.options.length === 0) {
      return typeof newValue === 'string' ? newValue : null;
    }

    if (typeof newValue !== 'string') {
      return this.options[0]?.value ?? null;
    }

    return this.options.some((option) => option.value === newValue)
      ? newValue
      : this.options[0]?.value ?? null;
  }

  protected override getText_() {
    return this.getOption(this.getValue() ?? '')?.label ?? '';
  }

  protected override showEditor_() {
    if (!this.isCurrentlyEditable() || typeof document === 'undefined') {
      return;
    }

    Blockly.DropDownDiv.hideIfOwner(this, true);
    Blockly.DropDownDiv.clearContent();
    const contentDiv = Blockly.DropDownDiv.getContentDiv();

    const wrapper = document.createElement('div');
    wrapper.className = 'blockly-search-dropdown';
    const stopPropagation = (event: Event) => event.stopPropagation();
    wrapper.addEventListener('mousedown', stopPropagation);
    wrapper.addEventListener('pointerdown', stopPropagation);
    wrapper.addEventListener('click', stopPropagation);

    const searchInput = document.createElement('input');
    searchInput.className = 'blockly-search-dropdown__search';
    searchInput.placeholder = 'Search predicates';
    searchInput.type = 'search';
    wrapper.append(searchInput);

    const list = document.createElement('div');
    list.className = 'blockly-search-dropdown__list';
    wrapper.append(list);
    contentDiv.append(wrapper);

    const renderList = (query: string) => {
      list.replaceChildren();
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const visibleOptions = this.options.filter((option) => option.searchText?.includes(normalizedQuery));

      if (visibleOptions.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'blockly-search-dropdown__empty';
        emptyState.textContent = 'No matching predicates';
        list.append(emptyState);
        return;
      }

      visibleOptions.forEach((option) => {
        const button = document.createElement('button');
        button.className = 'blockly-search-dropdown__option';
        button.type = 'button';

        if (option.value === this.getValue()) {
          button.classList.add('blockly-search-dropdown__option--selected');
        }

        button.textContent = option.label;
        button.addEventListener('click', () => {
          this.setValue(option.value);
          Blockly.DropDownDiv.hideIfOwner(this, true);
        });
        list.append(button);
      });
    };

    searchInput.addEventListener('input', () => {
      renderList(searchInput.value);
    });

    Blockly.DropDownDiv.setColour('#fffaf3', '#d7b98c');
    Blockly.DropDownDiv.showPositionedByField(this, () => {
      wrapper.remove();
    });

    renderList('');
    setTimeout(() => searchInput.focus(), 0);
  }

  private getOption(value: string) {
    return this.options.find((option) => option.value === value);
  }
}
