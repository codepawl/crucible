import { STUDIO_PROPERTY_SECTION_ICONS } from './studio-icons.js';
import { directionToSunAngles, hexToLinearRgb, linearRgbToHex } from './studio-controller.js';
import {
  formatPropertyNumber,
  hdriChoiceLabel,
  motionPropertyOf,
  parsePropertyInput,
  propertyDisplayRange,
  propertyDisplayValue,
  propertyIsEnabled,
  propertyIsVisible,
  propertyNameOf,
  propertySectionsFor,
  propertyStoredValue,
  propertyUnitMark,
  propertyValueText,
} from './studio-properties.js';

// Vector fields show three decimals at most, so a value such as 46.324 fits the field beside its axis letter.
const VECTOR_DISPLAY_PRECISION = 1000;
const DRIVEN_LABEL = 'Animated by a track';

/**
 * One line of a property panel: the label on the left and the control in the value column on the right.
 * `controls` are the elements of the value column, in order; the line is a grid of the label and them.
 */
export function createPropertyLine(documentReference, createElement, label, ...controls) {
  const head = createElement(documentReference, 'div', { className: 'crucible-studio-prop-head' }, createElement(documentReference, 'span', { className: 'crucible-studio-prop-label', textContent: label, title: label }));
  return createElement(documentReference, 'div', { className: 'crucible-studio-prop' }, head, ...controls);
}

/**
 * Draws the property rows of one scene object from the table in studio-properties.js and keeps them in step with the recipe.
 * The panel shows whatever object `resolveKey` names; `sync` re-reads the recipe, so an edit an agent makes shows up there.
 * `builders` are the control builders of studio.js, handed in so both draw the same controls.
 * `groups` ({ isOpen(id, openByDefault), setOpen(id, open) }) remembers which section titles a person folded.
 * `opensFirstGroup` starts the panel's first group open; every other group starts folded.
 * `leadingRows` ({ [sectionId]: element }) puts an element as the first row of that section.
 * `catalogNames` ({ [id]: name }) names the catalog HDRIs a scene may use.
 * `prepareRecipe` loads what a choice needs before it is written (the file of an HDRI), for a row that names a `preparation`.
 */
export function createPropertyPanel({ documentReference, controller, announce, builders, resolveKey, groups, prepareRecipe, opensFirstGroup = false, leadingRows = {}, catalogNames = {}, getLengthUnit = () => 'm' }) {
  const { createElement, createIcon, createVectorRow, createSunPad } = builders;
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-properties' });
  let shownKind = null;
  let shownLengthUnit = getLengthUnit();
  let controls = new Map();
  // The last number each clearable row showed, so a cleared row can show it again and a switch can write it back.
  let lastShownNumbers = new Map();

  function currentContext() {
    return { aspect: controller.viewportWidth / controller.viewportHeight, lastValueOf: id => lastShownNumbers.get(id) };
  }

  // Where the patch of each kind goes; every other kind is a light.
  const PATCH_WRITERS = {
    camera: (key, patch) => controller.updateSceneCamera(patch),
    sun: (key, patch) => controller.updateLook({ environment: patch }),
    world: (key, patch) => controller.updateLook({ environment: patch }),
    quality: (key, patch) => controller.updateLook({ environment: patch }),
    effects: (key, patch) => controller.updateLook({ effects: patch }),
    shadow: (key, patch) => controller.updateSceneShadow(patch),
  };

  function writePatch(key, kind, patch) {
    const write = PATCH_WRITERS[kind] ?? ((lightKey, lightPatch) => controller.updateSceneLight(lightKey, lightPatch));
    write(key, patch);
  }

  function reportRefusal(error) {
    announce(error);
    sync();
  }

  function writeField(field, value) {
    const key = resolveKey();
    const description = controller.describeSceneObject(key);
    writePatch(key, description.kind, field.write(value, description.source, currentContext()));
  }

  // An edit the recipe refuses (a far plane behind the near one) is told to the person and the controls go back to the recipe.
  function commit(field, value) {
    if (field.preparation && value !== null && prepareRecipe) {
      prepareRecipe(field.preparation(value)).then(() => writeField(field, value)).catch(reportRefusal);
      return;
    }
    try {
      writeField(field, value);
    } catch (error) {
      reportRefusal(error);
    }
  }

  function createDrivenMark() {
    const mark = createElement(documentReference, 'span', {
      className: 'crucible-studio-driven-mark',
      hidden: true,
      title: DRIVEN_LABEL,
      attributes: { role: 'img', 'aria-label': DRIVEN_LABEL },
    }, createIcon(documentReference, 'keyframe'));
    return mark;
  }

  function headOf(container) {
    return container.querySelector('.crucible-studio-prop-head') ?? container.querySelector('.crucible-studio-field-head') ?? container;
  }

  // Every numeric row has the slot, empty when it has no unit, so its digits end at the same place as the rows that do.
  function createUnitMark(field) {
    return createElement(documentReference, 'span', {
      className: 'crucible-studio-prop-unit',
      textContent: propertyUnitMark(field, getLengthUnit()),
      attributes: { 'aria-hidden': 'true' },
    });
  }

  function numberControl(field) {
    const isLength = field.unit === 'm';
    const range = propertyDisplayRange(field, getLengthUnit());
    const input = createElement(documentReference, 'input', {
      type: isLength ? 'text' : 'number',
      ...(isLength ? { dataset: { length: 'true' } } : { min: String(range.min), max: String(range.max), step: String(range.step) }),
      placeholder: field.clearable && field.offValue === undefined ? 'Off' : '',
      attributes: isLength ? { 'aria-label': propertyNameOf(field), inputmode: 'decimal' } : { 'aria-label': propertyNameOf(field) },
    });
    input.addEventListener('change', () => {
      if (input.value === '' && field.clearable) {
        commit(field, null);
        return;
      }
      const parsed = parsePropertyInput(field, input.value, getLengthUnit());
      if (parsed !== null) {
        commit(field, parsed);
      } else if (input.value !== '') {
        sync();
      }
    });
    const unitMark = createUnitMark(field);
    return {
      container: createPropertyLine(documentReference, createElement, field.label, input, unitMark),
      setValue: value => {
        if (value !== null) {
          lastShownNumbers.set(field.id, value);
        }
        const shownValue = value ?? lastShownNumbers.get(field.id) ?? field.offValue ?? null;
        input.value = shownValue === null ? '' : propertyValueText(field, shownValue, getLengthUnit());
      },
      setDisabled: disabled => {
        input.disabled = disabled;
      },
      setUnit: unit => {
        unitMark.textContent = propertyUnitMark(field, unit);
      },
    };
  }

  // A bounded number: a slim slider with its value beside it on the same line.
  function sliderControl(field) {
    const range = propertyDisplayRange(field, getLengthUnit());
    const output = createElement(documentReference, 'output');
    const input = createElement(documentReference, 'input', {
      type: 'range',
      min: String(range.min),
      max: String(range.max),
      step: String(range.step),
      value: String(range.min),
      attributes: { 'aria-label': propertyNameOf(field) },
    });
    input.addEventListener('input', () => {
      const shown = Number(input.value);
      output.textContent = formatPropertyNumber(shown);
      commit(field, propertyStoredValue(field, shown, getLengthUnit()));
    });
    const unitMark = createUnitMark(field);
    return {
      container: createPropertyLine(documentReference, createElement, field.label, input, output, unitMark),
      setValue: value => {
        const unit = getLengthUnit();
        input.value = String(propertyDisplayValue(field, value, unit));
        output.textContent = propertyValueText(field, value, unit);
      },
      setDisabled: disabled => {
        input.disabled = disabled;
      },
      setUnit: unit => {
        unitMark.textContent = propertyUnitMark(field, unit);
        const nextRange = propertyDisplayRange(field, unit);
        input.min = String(nextRange.min);
        input.max = String(nextRange.max);
        input.step = String(nextRange.step);
      },
    };
  }

  function colourControl(field) {
    const input = createElement(documentReference, 'input', { type: 'color', value: '#ffffff', attributes: { 'aria-label': propertyNameOf(field) } });
    input.addEventListener('input', () => commit(field, hexToLinearRgb(input.value)));
    return {
      container: createPropertyLine(documentReference, createElement, field.label, input),
      setValue: value => {
        input.value = linearRgbToHex(value);
      },
      setDisabled: disabled => {
        input.disabled = disabled;
      },
    };
  }

  // A switch: its knob sits at the right and its track is filled when on, at the left and empty when off.
  function toggleControl(field) {
    const knob = createElement(documentReference, 'span', { className: 'crucible-studio-switch-knob', attributes: { 'aria-hidden': 'true' } });
    const button = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-switch',
      attributes: { role: 'switch', 'aria-checked': 'false', 'aria-label': propertyNameOf(field) },
    }, knob);
    button.addEventListener('click', () => commit(field, button.getAttribute('aria-checked') !== 'true'));
    return {
      container: createPropertyLine(documentReference, createElement, field.label, button),
      setValue: value => button.setAttribute('aria-checked', value ? 'true' : 'false'),
      setDisabled: disabled => {
        button.disabled = disabled;
        button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      },
    };
  }

  function vectorControl(field) {
    const axisNames = ['x', 'y', 'z'].slice(0, field.axes ?? 3);
    const row = createVectorRow(documentReference, field.label, values => commit(field, values), {
      axisNames,
      accessibleTitle: propertyNameOf(field),
      getLengthUnit: field.unit === 'm' ? getLengthUnit : null,
      onGestureStart: () => controller.beginUndoGroup(),
      onGestureEnd: () => controller.endUndoGroup(),
    });
    return { container: row.container, setValue: values => row.setValues(values, VECTOR_DISPLAY_PRECISION), setDisabled: row.setDisabled };
  }

  // A choice from a short list. A value the list lacks (a catalog file the scene names) shows as a read-only current choice.
  function selectControl(field) {
    const select = createElement(documentReference, 'select', { attributes: { 'aria-label': propertyNameOf(field) } });
    const optionValue = value => (value === null ? '' : value);
    select.append(...field.choices.map(choice => createElement(documentReference, 'option', { value: optionValue(choice.value), textContent: choice.label })));
    select.addEventListener('change', () => commit(field, select.value === '' ? null : select.value));
    let unlistedOption = null;
    return {
      container: createPropertyLine(documentReference, createElement, field.label, select),
      setValue: value => {
        unlistedOption?.remove();
        unlistedOption = null;
        if (value !== null && !field.choices.some(choice => choice.value === value)) {
          unlistedOption = createElement(documentReference, 'option', { value, textContent: hdriChoiceLabel(value, catalogNames), disabled: true });
          select.append(unlistedOption);
        }
        select.value = optionValue(value);
      },
      setDisabled: disabled => {
        select.disabled = disabled;
      },
    };
  }

  function sunPadControl(field) {
    const pad = createSunPad(documentReference, angles => controller.setSunAngles(angles), {
      onDragStart: () => controller.beginUndoGroup(),
      onDragEnd: () => controller.endUndoGroup(),
    });
    const azimuthOutput = createElement(documentReference, 'output');
    const elevationOutput = createElement(documentReference, 'output');
    const readout = createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-sun-readout' },
      createElement(documentReference, 'div', {}, createElement(documentReference, 'span', { textContent: 'Az', title: 'Azimuth' }), azimuthOutput),
      createElement(documentReference, 'div', {}, createElement(documentReference, 'span', { textContent: 'El', title: 'Elevation' }), elevationOutput),
    );
    const control = createElement(documentReference, 'div', { className: 'crucible-studio-sun-control' }, pad.element, readout);
    return {
      container: createPropertyLine(documentReference, createElement, field.label, control),
      setValue: direction => {
        const angles = directionToSunAngles(direction);
        pad.setAngles(angles.azimuthDegrees, angles.elevationDegrees);
        azimuthOutput.textContent = `${Math.round(angles.azimuthDegrees)}°`;
        elevationOutput.textContent = `${Math.round(angles.elevationDegrees)}°`;
      },
      setDisabled: pad.setDisabled,
    };
  }

  const CONTROL_BUILDERS = { select: selectControl, number: numberControl, slider: sliderControl, colour: colourControl, toggle: toggleControl, vector: vectorControl, sunpad: sunPadControl };

  function buildRow(field) {
    const control = CONTROL_BUILDERS[field.control](field);
    const mark = createDrivenMark();
    headOf(control.container).append(mark);
    control.container.dataset.property = field.id;
    control.container.dataset.control = field.control;
    return { ...control, mark };
  }

  function rebuild(kind) {
    shownKind = kind;
    controls = new Map();
    lastShownNumbers = new Map();
    element.replaceChildren(...propertySectionsFor(kind).map(buildSection));
  }

  function buildSection(section, index) {
    const leadingRow = leadingRows[section.id] ? [leadingRows[section.id]] : [];
    const rows = createElement(documentReference, 'div', { className: 'crucible-studio-property-rows' }, ...leadingRow, ...section.fields.map(field => {
      const row = buildRow(field);
      controls.set(field.id, { field, ...row });
      return row.container;
    }));
    const chevron = createIcon(documentReference, 'chevron');
    chevron.setAttribute('class', 'crucible-studio-icon crucible-studio-chevron');
    const sectionIcon = createIcon(documentReference, STUDIO_PROPERTY_SECTION_ICONS[section.id]);
    sectionIcon.setAttribute('class', 'crucible-studio-icon crucible-studio-section-icon');
    const title = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-property-title',
      attributes: { 'aria-expanded': 'true' },
    }, chevron, sectionIcon, createElement(documentReference, 'span', { textContent: section.title }));
    const container = createElement(documentReference, 'div', { className: 'crucible-studio-property-section', dataset: { section: section.id } }, title, rows);
    const showOpen = open => {
      container.dataset.open = open ? 'true' : 'false';
      title.setAttribute('aria-expanded', open ? 'true' : 'false');
      rows.hidden = !open;
    };
    showOpen(groups.isOpen(section.id, opensFirstGroup && index === 0));
    title.addEventListener('click', () => {
      const open = container.dataset.open !== 'true';
      groups.setOpen(section.id, open);
      showOpen(open);
    });
    return container;
  }

  function sync() {
    const description = controller.describeSceneObject(resolveKey());
    const lengthUnit = getLengthUnit();
    const unitChanged = lengthUnit !== shownLengthUnit;
    shownLengthUnit = lengthUnit;
    if (description.kind !== shownKind) {
      rebuild(description.kind);
    }
    const context = currentContext();
    for (const { field, container, mark, setValue, setDisabled, setUnit } of controls.values()) {
      if (unitChanged) {
        setUnit?.(lengthUnit);
      }
      container.hidden = !propertyIsVisible(field, description.source);
      const driven = description.drivenProperties.has(motionPropertyOf(field));
      container.dataset.driven = driven ? 'true' : 'false';
      mark.hidden = !driven;
      const enabled = propertyIsEnabled(field, description.source);
      container.dataset.dimmed = enabled ? 'false' : 'true';
      setDisabled(driven || !enabled);
      if (field.read) {
        setValue(field.read(description.source, context));
      }
    }
  }

  return { element, sync };
}
