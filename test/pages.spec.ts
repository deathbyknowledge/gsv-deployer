import { describe, expect, it } from "vitest";

import { getDeployHelp } from "../src/deploy-help";
import { confirmDeletePage, deployPage, homePage, managePage } from "../src/pages";

describe("free deployment copy", () => {
  it("explains the billing scope and paid-only CodeMode capability", () => {
    const deploy = deployPage(
      [{ id: "account-id", name: "Account" }],
      "account-settings.read billing.read workers-scripts.write",
      [],
      [],
    );

    expect(deploy).toContain("Check whether the account uses Workers Free or Paid");
    const home = homePage("https://github.com/example/gsv");
    expect(home).toContain("Workers Free is supported");
    expect(home).toContain("Workers Paid adds CodeMode and more CPU");
    expect(home).not.toContain("packages");
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

  it("keeps internal Worker components out of deployment choices", () => {
    const create = deployPage(
      [{ id: "account-id", name: "Account" }],
      "workers-scripts.write",
      [],
      [],
    );
    const update = deployPage(
      [{ id: "account-id", name: "Account" }],
      "workers-scripts.write",
      [],
      [],
      {
        mode: "update",
        accountId: "account-id",
        instance: "gsv",
      },
    );

    expect(create).toContain("installer handles the complete stack");
    expect(create).not.toContain('name="component"');
    expect(create).not.toContain("Discord bot token");
    expect(update).toContain("complete GSV installation");
    expect(update).not.toContain('name="component"');

    const invalidStackHelp = getDeployHelp("No components selected.");
    expect(invalidStackHelp.whatToDo).not.toMatch(/select .*component/i);
  });

  it("presents installations as managed cards and separates new deployment", () => {
    const overview = managePage([
      {
        accountId: "account-id",
        accountName: "Account",
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: true,
      },
    ]);

    expect(overview).toContain("Manage your existing GSVs");
    expect(overview).toContain('class="manage-card"');
    expect(overview).toContain("Managed install");
    expect(overview).toContain("Want to deploy a new one?");
    expect(overview).not.toContain("component-badges");
    expect(overview).not.toContain("<li class=\"manage-card\"");
  });

  it("summarizes deletion outcomes before showing Worker IDs", () => {
    const confirmation = confirmDeletePage({
      accountId: "account-id",
      accountName: "Account",
      instance: "gsv",
      components: ["ripgit", "gateway"],
      scriptNames: ["ripgit", "gsv"],
      deleteSupported: true,
    });

    expect(confirmation).toContain("GSV and its connected services");
    expect(confirmation).toContain("Your files and storage");
    expect(confirmation).toContain("Technical details");
    expect(confirmation.indexOf("Technical details")).toBeLessThan(confirmation.indexOf("ripgit"));
    expect(confirmation).toContain("This does not delete files");
  });

  it("keeps name-matched installations unverified when management tags are absent", () => {
    const overview = managePage([
      {
        accountId: "account-id",
        accountName: "Account",
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: false,
      },
    ]);

    expect(overview).toContain("Unverified install");
    expect(overview).toContain("legacy GSV installation or a name collision");
    expect(overview).not.toContain("/manage/delete?");
  });
});
