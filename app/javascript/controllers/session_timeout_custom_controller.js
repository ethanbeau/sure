import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["select", "input", "duration"];

  connect() {
    this.toggle();
  }

  toggle() {
    const custom = this.selectTarget.value === "custom";
    this.inputTarget.hidden = !custom;
    this.durationTarget.required = custom;
    this.durationTarget.disabled = !custom;
  }
}
