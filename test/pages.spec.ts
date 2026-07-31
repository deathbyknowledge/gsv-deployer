import { describe, expect, it } from "vitest";

import { getDeployHelp } from "../src/deploy-help";
import { deployPage, homePage } from "../src/pages";

describe("free deployment copy", () => {
  it("explains the billing scope and paid-only CodeMode capability", () => {
    const deploy = deployPage(
      [{ id: "account-id", name: "Account" }],
      "account-settings.read billing.read workers-scripts.write",
      [],
      [],
    );

    expect(deploy).toContain("Check whether the account uses Workers Free or Paid");
    expect(homePage("https://github.com/example/gsv")).toContain(
      "Free installs omit this paid-only capability",
    );
  });

  it("does not tell free-account users to upgrade when storage setup fails", () => {
    const storageHelp = getDeployHelp("Create R2 bucket failed");
    expect(storageHelp.whatToDo).toContain("Confirm R2 is enabled");
    expect(storageHelp.whatToDo).not.toContain("Workers Paid");
  });

  it("describes assembler as release-driven legacy compatibility", () => {
    const dependencyHelp = getDeployHelp("The selected gateway release requires the legacy assembler Worker.");
    expect(dependencyHelp.detail).toContain("legacy assembly Worker");
    expect(dependencyHelp.whatToDo).toContain("Legacy releases");
  });
});
