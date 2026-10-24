/** Colors offered as one-click swatches. Any color can still be chosen with the color input. */
export const SWATCHES: { name: string; value: string }[] = [
  { name: "Blue", value: "#3b6fc4" },
  { name: "Orange", value: "#e8833a" },
  { name: "Green", value: "#3fa56b" },
  { name: "Purple", value: "#8a5cc7" },
  { name: "Pink", value: "#d1568a" },
  { name: "Teal", value: "#2a9d9f" },
  { name: "Red", value: "#c0504d" },
  { name: "Gold", value: "#d4a72c" },
  { name: "Gray", value: "#6b7280" },
];

export const BACKGROUNDS: { name: string; value: string }[] = [
  { name: "Ority", value: "#fbfafc" },
  { name: "Cream", value: "#f5f3ed" },
  { name: "Soft gray", value: "#f4f5f7" },
  { name: "Warm", value: "#fbf6ee" },
  { name: "Cool", value: "#eef4fb" },
  { name: "Mint", value: "#eef7f1" },
  { name: "Lavender", value: "#f3f0fa" },
  { name: "White", value: "#ffffff" },
];

export function ColorPicker(props: { label: string; value: string; onChange: (v: string) => void; options?: { name: string; value: string }[] }) {
  const options = props.options ?? SWATCHES;
  return (
    <fieldset class="color-picker">
      <legend>{props.label}</legend>
      <div class="swatches" role="radiogroup" aria-label={props.label}>
        {options.map((o) => (
          <button
            type="button" key={o.value} role="radio" aria-checked={props.value.toLowerCase() === o.value} aria-label={o.name}
            class="swatch" style={{ background: o.value }} onClick={() => props.onChange(o.value)}
          />
        ))}
        <label class="custom-color">
          <span class="sr-only">Custom {props.label.toLowerCase()}</span>
          <input type="color" value={props.value} onChange={(e) => props.onChange((e.target as HTMLInputElement).value)} />
        </label>
      </div>
    </fieldset>
  );
}
