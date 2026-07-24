import type { Theme } from "../constants";
import SegmentedControl from "./SegmentedControl";

/** filefind-style segmented control for light / dark / system theme,
 *  with a sliding indicator. */
export default function ThemeSwitch({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (t: Theme) => void;
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={[
        { value: "light", icon: "☀️", label: "" },
        { value: "dark", icon: "🌙", label: "" },
        { value: "system", icon: "💻", label: "" },
      ]}
    />
  );
}
