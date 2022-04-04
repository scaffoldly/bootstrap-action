const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");
const proc = require("child_process");
const fs = require("fs");
const semver = require("semver");
const immutable = require("immutable");
const boolean = require("boolean");

const SLY_FILE = "./sly.json";
const TERRAFORM_DIRECTORY = "./.terraform";
const BACKEND_HCL_FILE = `${TERRAFORM_DIRECTORY}/backend.hcl`;
const TERRAFORM_OUTPUT_FILE = `${TERRAFORM_DIRECTORY}/output.json`;

const repoInfo = async () => {
  const rootEmail = core.getInput("root-email");
  await simpleGit
    .default()
    .addConfig("user.name", "Scaffoldly Bootstrap Action");
  await simpleGit.default().addConfig("user.email", rootEmail);

  const log = await simpleGit.default().log({ maxCount: 1 });
  const sha = log.latest.hash;

  const remotes = await simpleGit.default().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { pathname } = new URL(origin.refs.push);
  if (!pathname) {
    throw new Error(`Unable to extract pathname from ${origin.refs.push}`);
  }

  const organization = pathname.split("/")[1];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${pathname}`);
  }

  const repo = pathname.split("/")[2];
  if (!repo) {
    throw new Error(`Unable to extract repo from ${pathname}`);
  }

  const info = { organization, repo, sha };

  console.log("Repo Info: ", JSON.stringify(info, null, 2));

  return info;
};

const slyVersionFetch = () => {
  const slyFile = JSON.parse(fs.readFileSync(SLY_FILE));
  const version = semver.parse(slyFile.version);
  return version;
};

const slyVersionSet = (version) => {
  const slyFile = JSON.parse(fs.readFileSync(SLY_FILE));
  slyFile.version = version;
  fs.writeFileSync(SLY_FILE, JSON.stringify(slyFile));
};

const parseWorkspace = (workspace) => {
  const moduleDirectory = core.getInput("module-directory", {
    required: false,
  });

  const workspaceName =
    core.getInput("workspace", {
      required: false,
    }) || workspace;

  if (!moduleDirectory) {
    return { workspaceName, tagPrefix: `` };
  }

  const tagPrefix = moduleDirectory
    .replace(/^(\.\/)/, "") // trim off leading ./
    .replace(/[/]$/, ""); // trim off trailing /

  const scrubbedModuleDirectory = tagPrefix
    .replace(/[/]/gm, "--") // convert / into --
    .replace(/[^a-zA-Z0-9]/gm, "-"); // non alphanum to dashes

  return {
    workspaceName: `${workspaceName}-${scrubbedModuleDirectory}`,
    tagPrefix: `${tagPrefix}/`,
  };
};

const prerelease = async (workspace, prereleaseCommit) => {
  const version = slyVersionFetch();
  const { tagPrefix } = parseWorkspace(workspace);

  if (!prereleaseCommit) {
    const identifier = core.getInput("identifier", { required: false });
    const newVersion = identifier
      ? semver.parse(`${version.version}-${identifier}`)
      : version;
    return {
      version: newVersion,
      tagName: `${tagPrefix}${newVersion.version}`,
    };
  }

  const newVersion = semver.parse(semver.inc(version, "prerelease"));

  slyVersionSet(version.version);

  const title = `CI: Prerelease: ${newVersion.version}`;

  const versionCommit = await simpleGit.default().commit(title, SLY_FILE);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(versionCommit)
  );

  const tag = await simpleGit
    .default()
    .addTag(`${tagPrefix}${newVersion.version}`);
  console.log(`Created new tag: ${tag.name}`);

  await simpleGit.default().push(["--follow-tags"]);
  await simpleGit.default().pushTags();

  return { version: newVersion, tagName: tag.name };
};

const postrelease = async (org, repo, postreleaseCommit) => {
  const version = slyVersionFetch();

  if (!postreleaseCommit) {
    const identifier = core.getInput("identifier", { required: false });
    const newVersion = identifier
      ? semver.parse(`${version}-${identifier}`)
      : version;
    return { version: newVersion };
  }

  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const info = await octokit.repos.get({ owner: org, repo });
  const defaultBranch = info.data.default_branch;

  await simpleGit.default().fetch();
  await simpleGit.default().checkout(defaultBranch);

  const newVersion = semver.parse(semver.inc(version, "patch"));

  slyVersionSet(newVersion.version);

  const title = `CI: Postrelease: ${newVersion.version}`;

  const commit = await simpleGit.default().commit(title, SLY_FILE);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(commit)
  );

  await simpleGit.default().push();

  return { version: newVersion };
};

const parsePlan = (plan) => {
  const planRegex =
    /  # (?<ResourceName>.*?) (?<ResourceActionStr>.*)\n(?<ExtraInfo>.*?\n)?\s*(?<ResourceActionSymbol>.*) resource "(?<Resource>.*)" "(?<ResourceId>.*)" {/gm;
  const planSummaryRegex = /\nPlan:(?<Summary>.*\.)\n\n/gm;
  const refreshingStateRegex = /: Refreshing state... /gm;

  // https://github.com/hashicorp/terraform/blob/2b6a1be18f9b9ccb6041bd656e62e5b3fc128d61/internal/command/format/diff.go#L1916
  const ret = {
    destroyCreate: [], // '-/+'
    createDestroy: [], // '+/-'
    create: [], // '  +'
    destroy: [], // '  -'
    update: [], // '  ~'
    summary: null,
    existingResources: (plan.match(refreshingStateRegex) || []).length,
  };

  try {
    if (plan.indexOf("\n\nNo changes.") !== -1) {
      ret.summary = "No changes. Infrastructure is up-to-date.";
      return ret;
    }

    const separatorIx = plan.indexOf(
      "Terraform will perform the following actions:"
    );

    if (separatorIx === -1) {
      ret.summary =
        "Unable to parse plan. Please file a bug report on scaffoldly/bootstrap-action";
      core.warning("Unable to parse plan.");
      return ret;
    }

    const summaryExtract = planSummaryRegex.exec(plan);
    if (summaryExtract && summaryExtract.groups) {
      ret.summary = summaryExtract.groups.Summary;
    }

    const actionPlan = plan.substring(separatorIx);

    let extracted = planRegex.exec(actionPlan);
    while (extracted && extracted.groups) {
      const { ResourceName, ResourceActionSymbol } = extracted.groups;
      switch (ResourceActionSymbol) {
        case "-/+":
          ret.destroyCreate.push(ResourceName);
          break;
        case "+/-":
          ret.createDestroy.push(ResourceName);
          break;
        case "+":
          ret.create.push(ResourceName);
          break;
        case "-":
          ret.destroy.push(ResourceName);
          break;
        case "~":
          ret.update.push(ResourceName);
          break;
        default:
          console.warn("Unknown symbol", extracted.groups);
          core.warning(`Unknown symbol: ${ResourceActionSymbol}`);
          break;
      }

      extracted = planRegex.exec(actionPlan);
    }
  } catch (e) {
    console.error("Unable to parse plan", e);
    core.warning(`Unable to parse plan ${e.message}`);
  }

  return ret;
};

const summarizeChanges = (changes, title) => {
  if (!changes || !changes.length) {
    return "";
  }

  let ret = `
### ${title}:
${changes.map((change) => `  - \`${change}\``).join("\n")}
`;

  return ret;
};

// TODO: Handle PR -- Plan only as PR Comment
// TODO: Skip if commit message is "Initial Whatever" (from repo template)
// TODO: Glob Up Commit Messages since last release
// TODO: Unique tag names if
const draftRelease = async (org, repo, tagName, plan, files) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const parsed = parsePlan(plan);

  let body = `
# Summary for ${tagName}:

 - Existing Resources: \`${parsed.existingResources}\`
${parsed.summary ? ` - Plan: ${parsed.summary}` : ""}

## Proposed Changes:
`;

  if (
    !parsed.create.length &&
    !parsed.createDestroy.length &&
    !parsed.destroy.length &&
    !parsed.destroyCreate.length &&
    !parsed.update.length
  ) {
    body = `
${body}
 - None    
`;
  } else {
    body = `
${body}
${summarizeChanges(parsed.destroy, "Destroy")}
${summarizeChanges(parsed.destroyCreate, "Destroy (then re-create)")}
${summarizeChanges(parsed.create, "Create")}
${summarizeChanges(
  parsed.createDestroy,
  "Create (then destroy the former resource)"
)}
${summarizeChanges(parsed.update, "Update (in-place)")}
`;
  }

  body = `
${body}

## More detail needed? 

Please check the output from the action that generated this release,
or download the attached \`plan-output.txt\` file to this release for
more specific detail.
`;

  if (body.length > 125000) {
    body = `
A plan was created but it was too long to display here.

Please check the output from the action that generated this release,
or download the attached \`plan-output.txt\` file to this release.
`;
  }

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: tagName,
    tag_name: tagName,
    draft: true,
    body,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);

  const assetUploadPromises = Object.entries(files).map(
    async ([filename, path]) => {
      const asset = await octokit.repos.uploadReleaseAsset({
        owner: org,
        repo,
        release_id: release.data.id,
        name: filename,
        data: fs.readFileSync(path),
      });

      console.log(
        `Uploaded file to release ${release.data.name}: ${asset.data.url}`
      );
    }
  );

  await Promise.all(assetUploadPromises);
};

const fetchRelease = async (org, repo) => {
  const { GITHUB_REF: githubRef } = process.env;
  if (!githubRef.startsWith("refs/tags/")) {
    throw new Error(`Unable to apply, not a tag: ${githubRef}`);
  }

  const parts = githubRef.split("/").slice(2);
  const version = semver.parse(parts.slice(-1)[0]);
  const tagPrefix = parts.slice(0, -1).join("/");
  const moduleDirectory = parts.length > 1 ? `./${tagPrefix}` : null;

  const tagName = `${tagPrefix}${version.version}`;

  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.getReleaseByTag({
    owner: org,
    repo,
    tag: tagName,
  });
  if (!release || !release.data || !release.data.id) {
    throw new Error(`Unable to find a release for tag: ${tagName}`);
  }

  console.log(`Found release ID ${release.data.id} for tag ${tagName}`);

  const releaseAssets = await octokit.repos.listReleaseAssets({
    owner: org,
    repo,
    release_id: release.data.id,
  });
  console.log(`Found ${releaseAssets.data.length} release assets`);
  const assetPromises = releaseAssets.data.map(async (releaseAsset) => {
    const { url } = await octokit.repos.getReleaseAsset({
      owner: org,
      repo,
      asset_id: releaseAsset.id,
      headers: { accept: "application/octet-stream" },
    });
    console.log(
      `Downloading release asset: ${releaseAsset.name} from url ${url}`
    );
    const { data } = await axios.default.get(url, {
      responseType: "arraybuffer",
      responseEncoding: "binary",
    });

    const path = `./${releaseAsset.name}`;
    fs.writeFileSync(path, data);

    return { [releaseAsset.name]: path };
  });
  const assets = await Promise.all(assetPromises);

  return {
    releaseId: release.data.id,
    version,
    tagName,
    moduleDirectory: moduleDirectory || undefined,
    files: immutable.merge({}, ...assets),
  };
};

const terraformPost = async (url, payload) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  try {
    const { status, data } = await axios.default.post(url, payload, {
      headers: {
        Authorization: `Bearer ${terraformCloudToken}`,
        "Content-Type": "application/vnd.api+json",
      },
    });

    return { status, data };
  } catch (e) {
    // ignore this type of response so our org/workspace creation is idempotent
    // {"errors":[{"status":"422","title":"invalid attribute","detail":"Name has already been taken","source":{"pointer":"/data/attributes/name"}}]}
    if (
      !e.response ||
      e.response.status !== 422 ||
      !e.response.data ||
      !e.response.data.errors ||
      e.response.data.errors.length !== 1 ||
      !e.response.data.errors[0] ||
      !e.response.data.errors[0].source ||
      !e.response.data.errors[0].source.pointer ||
      e.response.data.errors[0].source.pointer !== "/data/attributes/name"
    ) {
      console.error("Error posting to Terraform Cloud", e.message);
      throw e;
    }

    const { status, data } = e.response;

    return { status, data };
  }
};

const createTerraformOrganization = async (organization) => {
  const createOrg = boolean.boolean(
    core.getInput("create-organization", { required: false }) || "false"
  );
  if (!createOrg) {
    console.log("Skipping organization creation");
    return;
  }

  const rootEmail = core.getInput("root-email");

  const { status, data } = await terraformPost(
    "https://app.terraform.io/api/v2/organizations",
    {
      data: {
        type: "organizations",
        attributes: {
          name: organization,
          email: rootEmail,
        },
      },
    }
  );

  console.log(`[${status}] Create Org Response: ${JSON.stringify(data)}`);
};

const createTerraformWorkspace = async (organization, workspace) => {
  const stateProvider =
    core.getInput("state-provider", { required: false }) || "app.terraform.io";

  if (stateProvider !== "app.terraform.io") {
    return;
  }

  const { workspaceName } = parseWorkspace(workspace);

  const { status, data } = await terraformPost(
    `https://app.terraform.io/api/v2/organizations/${organization}/workspaces`,
    {
      data: {
        type: "workspaces",
        attributes: {
          name: workspaceName,
          operations: false,
        },
      },
    }
  );

  console.log(`[${status}] Create Workspace Response: ${JSON.stringify(data)}`);
};

const cleanseExecOutput = (output) => {
  let cleansed = output;
  // Remove GitHub enrichment of output
  cleansed = cleansed.replace(/^::debug::.*\n?/gm, "");
  cleansed = cleansed.replace(/^::set-output.*\n?/gm, "");
  return cleansed;
};

const exec = (org, command) => {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const env = {
      ...process.env,
      GITHUB_OWNER: org,
      GITHUB_ORGANIZATION: org,
      TF_VAR_BOOTSTRAP_ORGANIZATION: org.toLowerCase(),
    };

    console.log(`Using Env: ${JSON.stringify(env)}`);
    console.log(`Running Command: ${command}`);

    const parts = command.split(" ");
    const p = proc.spawn(parts[0], parts.slice(1), {
      shell: true,
      env: {
        ...process.env,
        TF_VAR_BOOTSTRAP_ORGANIZATION: org.toLowerCase(),
      },
    });

    p.on("error", (err) => {
      reject(err);
    });

    p.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({
          stdout: cleanseExecOutput(stdout),
          stderr: cleanseExecOutput(stderr),
        });
        return;
      }
      reject(new Error(`Command '${command}' exited with code ${code}`));
    });

    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stdout); // Pipe stderr to stdout too

    p.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`;
    });
    p.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`;
    });
  });
};

const terraformInit = async (organization, repo, moduleDirectory) => {
  const cwd = process.cwd();
  if (moduleDirectory) {
    process.chdir(moduleDirectory);
    console.log("Changed working directory", process.cwd());
  }

  const terraformCloudToken = core.getInput("terraform-cloud-token", {
    required: false,
  });
  const repoToken = core.getInput("repo-token");

  const stateProvider =
    core.getInput("state-provider", { required: false }) || "app.terraform.io";

  const { workspaceName } = parseWorkspace(repo);
  fs.mkdirSync(TERRAFORM_DIRECTORY);

  let command = `terraform init -backend-config=${BACKEND_HCL_FILE}`;

  if (stateProvider === "tfstate.dev") {
    fs.writeFileSync(
      BACKEND_HCL_FILE,
      `
address        = "https://api.tfstate.dev/github/v1"
lock_address   = "https://api.tfstate.dev/github/v1/lock"
unlock_address = "https://api.tfstate.dev/github/v1/lock"
lock_method    = "PUT"
unlock_method  = "DELETE"
username       = "${organization}/${repo}@${workspaceName}"
`
    );

    command = `${command} -backend-config="password=${repoToken}" -reconfigure`;
  } else {
    fs.writeFileSync(
      BACKEND_HCL_FILE,
      `
workspaces { name = "${workspaceName}" }
hostname     = "app.terraform.io"
organization = "${organization}"
`
    );

    command = `${command} -backend-config="token=${terraformCloudToken}"`;
  }

  await exec(organization, command);

  if (moduleDirectory) {
    process.chdir(cwd);
    console.log("Changed working directory", process.cwd());
  }
};

const terraformPlan = async (organization, planfile, moduleDirectory) => {
  const cwd = process.cwd();
  if (moduleDirectory) {
    process.chdir(moduleDirectory);
    console.log("Changed working directory", process.cwd());
  }

  const command = `terraform plan -no-color -out ${planfile}`;
  const { stdout: plan } = await exec(organization, command);

  fs.writeFileSync("plan-output.txt", plan);

  const encryptCommand = `gpg --batch -c --passphrase "${organization}" planfile`;
  await exec(organization, encryptCommand);

  if (moduleDirectory) {
    process.chdir(cwd);
    console.log("Changed working directory", process.cwd());
  }

  return {
    plan,
    planfile: "./planfile.gpg",
    planOutput: "./plan-output.txt",
  };
};

const terraformApply = async (org, planfile, moduleDirectory) => {
  const cwd = process.cwd();
  if (moduleDirectory) {
    process.chdir(moduleDirectory);
    console.log("Changed working directory", process.cwd());
  }

  const terraformCloudToken = core.getInput("terraform-cloud-token");
  const decryptCommand = `gpg --batch -d --passphrase "${org}" -o ./plan ${planfile}`;
  await exec(org, decryptCommand);

  let output;
  try {
    const command = `terraform apply -no-color plan`;
    const { stdout } = await exec(org, command);
    output = stdout;
  } catch (e) {
    console.log(
      "Error while applying, setting the action as failed, but continuing for housecleaning..."
    );
    core.setFailed(e);
    output = e.message;
  }

  if (moduleDirectory) {
    process.chdir(cwd);
    console.log("Changed working directory", process.cwd());
  }

  return { apply: output };
};

const terraformOutput = async (organization) => {
  const command = `terraform output -json`;

  let { stdout } = await exec(organization, command);

  const output = JSON.parse(stdout.split("\n").slice(1).join("\n")); // Trim the first line that shows the shell command

  return Object.entries(output).reduce((acc, [key, value]) => {
    acc[key] = value.value;
    return acc;
  }, {});
};

const event = (org, repo, action) => {
  const dnt = core.getInput("dnt", { required: false });
  if (dnt) {
    return;
  }

  axios.default
    .post(
      `https://api.segment.io/v1/track`,
      {
        userId: org,
        event: action,
        properties: { script: "bootstrap-action" },
        context: { repo },
      },
      { auth: { username: "RvjEAi2NrzWFz3SL0bNwh5yVwrwWr0GA", password: "" } }
    )
    .then(() => {})
    .catch((error) => {
      console.error("Event Log Error", error);
    });
};

const run = async () => {
  const action = core.getInput("action");
  const { organization, repo } = await repoInfo();
  event(organization, repo, action);

  core.setOutput("organization", organization);

  await createTerraformOrganization(organization);
  await createTerraformWorkspace(organization, repo);

  switch (action) {
    case "plan": {
      // TODO: lint planfile (terraform show -json planfile)
      const moduleDirectory = core.getInput("module-directory", {
        required: false,
      });
      await terraformInit(organization, repo, moduleDirectory);
      const { tagName } = await prerelease(
        repo,
        moduleDirectory ? false : true
      );
      const { plan, planfile, planOutput } = await terraformPlan(
        organization,
        "./planfile",
        moduleDirectory
      );
      await draftRelease(organization, repo, tagName, plan, {
        "plan-output.txt": planOutput,
        planfile,
      });
      break;
    }

    case "apply": {
      const { files, version, moduleDirectory } = await fetchRelease(
        organization,
        repo
      );
      if (!files || files.length === 0) {
        throw new Error(`No release assets on version ${version}`);
      }
      await terraformInit(organization, repo, moduleDirectory);
      await terraformApply(organization, files["planfile"], moduleDirectory);
      await postrelease(organization, repo, moduleDirectory ? false : true);
      break;
    }

    case "terraform": {
      const command = core.getInput("terraform", { required: true });
      const moduleDirectory = core.getInput("module-directory", {
        required: false,
      });
      await terraformInit(organization, repo, moduleDirectory);
      console.log(`Running terraform command: \`terraform ${command}\``);
      await exec(organization, `terraform ${command.split('"').join('\\"')}`);
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  // const tfOutput = await terraformOutput(organization);
  // console.log("Output from Terraform:\n", JSON.stringify(tfOutput, null, 2));

  // core.setOutput("terraform-output", tfOutput);
  // if (tfOutput.github_matrix_include) {
  //   core.setOutput("matrix", { include: tfOutput.github_matrix_include });
  // }
};

(async () => {
  try {
    await run();
  } catch (e) {
    console.error(e);
    core.setFailed(e.message);
  }
})();
