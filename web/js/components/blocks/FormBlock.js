import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { handleSend } from '../../app.js';

export function FormBlock({ id, title, description, fields, submitLabel, cancelLabel }) {
  if (!fields || !fields.length) return null;

  const [values, setValues] = useState(() => {
    const init = {};
    for (const f of fields) {
      if (f.type === 'checkbox') init[f.name] = f.default || false;
      else init[f.name] = f.default || '';
    }
    return init;
  });
  const [submitted, setSubmitted] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const setValue = (name, value) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // Build structured response
    const lines = [`[form: ${id || 'response'}]`];
    for (const f of fields) {
      const val = values[f.name];
      if (f.type === 'checkbox') {
        lines.push(`${f.name}: ${val ? 'true' : 'false'}`);
      } else if (val !== undefined && val !== '') {
        lines.push(`${f.name}: ${val}`);
      }
    }
    lines.push('[/form]');
    handleSend(lines.join('\n'));
    setSubmitted(true);
  };

  const handleCancel = () => {
    handleSend(`[form: ${id || 'response'}]\ncancelled: true\n[/form]`);
    setCancelled(true);
  };

  if (submitted) {
    return html`
      <div class="form-block form-block-done">
        <div class="form-done-icon">&#x2714;</div>
        <div class="form-done-text">${title ? `${title} — ` : ''}Submitted</div>
      </div>
    `;
  }

  if (cancelled) {
    return html`
      <div class="form-block form-block-done form-block-cancelled">
        <div class="form-done-icon">&#x2718;</div>
        <div class="form-done-text">${title ? `${title} — ` : ''}Cancelled</div>
      </div>
    `;
  }

  return html`
    <form class="form-block" onSubmit=${handleSubmit}>
      ${title && html`<div class="form-title">${title}</div>`}
      ${description && html`<div class="form-description">${description}</div>`}
      <div class="form-fields">
        ${fields.map((f) => html`<${FormField} key=${f.name} field=${f} value=${values[f.name]} onChange=${setValue} />`)}
      </div>
      <div class="form-actions">
        ${cancelLabel !== false && html`
          <button type="button" class="action-btn action-btn-default pixel-border" onClick=${handleCancel}>
            ${cancelLabel || 'Cancel'}
          </button>
        `}
        <button type="submit" class="action-btn action-btn-primary pixel-border">
          ${submitLabel || 'Submit'}
        </button>
      </div>
    </form>
  `;
}

function FormField({ field, value, onChange }) {
  const { name, label, type = 'text', required, placeholder, options, helpText } = field;
  const id = `form-field-${name}`;

  if (type === 'checkbox') {
    return html`
      <label class="form-field form-field-checkbox" for=${id}>
        <input
          id=${id}
          type="checkbox"
          checked=${value}
          onChange=${(e) => onChange(name, e.target.checked)}
        />
        <span class="form-field-label">${label}${required ? html` <span class="form-required">*</span>` : ''}</span>
        ${helpText && html`<div class="form-help">${helpText}</div>`}
      </label>
    `;
  }

  if (type === 'select') {
    return html`
      <div class="form-field">
        <label class="form-field-label" for=${id}>${label}${required ? html` <span class="form-required">*</span>` : ''}</label>
        <select
          id=${id}
          class="form-input form-select"
          value=${value}
          required=${required}
          onChange=${(e) => onChange(name, e.target.value)}
        >
          ${!required && !field.default && html`<option value="">-- Select --</option>`}
          ${(options || []).map((opt) => {
            const optVal = typeof opt === 'object' ? opt.value : opt;
            const optLabel = typeof opt === 'object' ? opt.label : opt;
            return html`<option value=${optVal}>${optLabel}</option>`;
          })}
        </select>
        ${helpText && html`<div class="form-help">${helpText}</div>`}
      </div>
    `;
  }

  if (type === 'textarea') {
    return html`
      <div class="form-field">
        <label class="form-field-label" for=${id}>${label}${required ? html` <span class="form-required">*</span>` : ''}</label>
        <textarea
          id=${id}
          class="form-input form-textarea"
          value=${value}
          required=${required}
          placeholder=${placeholder || ''}
          rows="3"
          onInput=${(e) => onChange(name, e.target.value)}
        />
        ${helpText && html`<div class="form-help">${helpText}</div>`}
      </div>
    `;
  }

  // text, email, url, number
  return html`
    <div class="form-field">
      <label class="form-field-label" for=${id}>${label}${required ? html` <span class="form-required">*</span>` : ''}</label>
      <input
        id=${id}
        type=${type}
        class="form-input"
        value=${value}
        required=${required}
        placeholder=${placeholder || ''}
        onInput=${(e) => onChange(name, e.target.value)}
      />
      ${helpText && html`<div class="form-help">${helpText}</div>`}
    </div>
  `;
}
