const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");
const proc = require("child_process");
const fs = require("fs");
const semver = require("semver");
const immutable = require("immutable");

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
  const workingDirectory = core.getInput("working-directory", {
    required: false,
  });

  if (!workingDirectory || workingDirectory === ".") {
    return { workspaceName: workspace, tagPrefix: `` };
  }

  const tagPrefix = workingDirectory
    .replace(/^(\.\/)/, "") // trim off leading ./
    .replace(/[/]$/, ""); // trim off trailing /

  const scrubbedWorkingDirectory = tagPrefix
    .replace(/[/]/gm, "--") // convert / into --
    .replace(/[^a-zA-Z0-9]/gm, "-"); // non alphanum to dashes

  return {
    workspaceName: `${workspace}-${scrubbedWorkingDirectory}`,
    tagPrefix: `${tagPrefix}/`,
  };
};

const prerelease = async (workspace) => {
  const version = slyVersionFetch();

  const newVersion = semver.parse(semver.inc(version, "prerelease"));

  slyVersionSet(version.version);

  const title = `CI: Prerelease: ${newVersion.version}`;

  const versionCommit = await simpleGit.default().commit(title, SLY_FILE);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(versionCommit)
  );

  const { tagPrefix } = parseWorkspace(workspace);

  const tag = await simpleGit
    .default()
    .addTag(`${tagPrefix}${newVersion.version}`);
  console.log(`Created new tag: ${tag.name}`);

  await simpleGit.default().push(["--follow-tags"]);
  await simpleGit.default().pushTags();

  return { version: newVersion, tagName: tag.name };
};

const postrelease = async (org, repo) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const info = await octokit.repos.get({ owner: org, repo });
  const defaultBranch = info.data.default_branch;

  await simpleGit.default().fetch();
  await simpleGit.default().checkout(defaultBranch);

  const version = slyVersionFetch();
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

// TODO: Handle PR -- Plan only as PR Comment
// TODO: Skip if commit message is "Initial Whatever" (from repo template)
// TODO: Glob Up Commit Messages since last release
const draftRelease = async (org, repo, tagName, plan, files) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: tagName,
    tag_name: tagName,
    draft: true,
    body: `
The following plan was created for ${tagName}:

\`\`\`
${plan}
\`\`\`
`,
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
        `Uploaded planfile to release ${release.data.name}: ${asset.data.url}`
      );
    }
  );

  await Promise.all(assetUploadPromises);
};

const fetchRelease = async (org, repo) => {
  const version = slyVersionFetch();
  if (version.prerelease.length === 0) {
    throw new Error(
      `Unable to apply, version not a prerelease: ${version.version}`
    );
  }

  let tagPrefix = "";
  const { GITHUB_REF: githubRef } = process.env;
  if (githubRef.startsWith("refs/tags/")) {
    const parts = githubRef.split("/").slice(2, -1);
    tagPrefix = parts.join("/");
    parts.forEach((part) => {
      process.chdir(part);
      console.log("Changed working directory", process.cwd());
    });
  }

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
      GITHUB_ORGANIZATION: org,
      TF_VAR_BOOTSTRAP_ORGANIZATION: org,
    };

    console.log(`Using Env: ${JSON.stringify(env)}`);
    console.log(`Running Command: ${command}`);

    const parts = command.split(" ");
    const p = proc.spawn(parts[0], parts.slice(1), {
      shell: true,
      env: {
        ...process.env,
        TF_VAR_BOOTSTRAP_ORGANIZATION: org,
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

const terraformInit = async (organization, workspace) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const { workspaceName } = parseWorkspace(workspace);

  fs.mkdirSync(TERRAFORM_DIRECTORY);
  fs.writeFileSync(
    BACKEND_HCL_FILE,
    `
workspaces { name = "${workspaceName}" }
hostname     = "app.terraform.io"
organization = "${organization}"
`
  );

  const command = `terraform init -backend-config=${BACKEND_HCL_FILE} -backend-config="token=${terraformCloudToken}"`;

  await exec(organization, command);
};

const terraformPlan = async (organization, planfile) => {
  const command = `terraform plan -no-color -out ${planfile}`;
  const { stdout: plan } = await exec(organization, command);
  const terraformCloudToken = core.getInput("terraform-cloud-token");
  const encryptCommand = `gpg --batch -c --passphrase "${terraformCloudToken}" planfile`;
  await exec(organization, encryptCommand);
  return { plan, planfile: "./planfile.gpg" };
};

const terraformApply = async (org, repo, planfile) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");
  const decryptCommand = `gpg --batch -d --passphrase "${terraformCloudToken}" -o ./plan ${planfile}`;
  await exec(org, decryptCommand);

  let version = semver.parse(semver.inc(slyVersionFetch(), "patch"));

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

  const { tagPrefix } = parseWorkspace(repo);
  const tagName = `${tagPrefix}${version.version}`;

  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: tagName,
    tag_name: tagName,
    body: `
The following was applied for ${tagName}:

\`\`\`
${output}
\`\`\`
`,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);

  return { apply: output, version, tagNam };
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

  const workingDirectory = core.getInput("working-directory", {
    required: false,
  });
  if (workingDirectory) {
    process.chdir(workingDirectory);
    console.log("Changed working directory", process.cwd());
  }

  core.setOutput("organization", organization);

  await createTerraformOrganization(organization);
  await createTerraformWorkspace(organization, repo);
  await terraformInit(organization, repo);

  switch (action) {
    case "plan": {
      // TODO: lint planfile (terraform show -json planfile)
      const { version } = await prerelease(repo);
      const { plan, planfile } = await terraformPlan(
        organization,
        "./planfile"
      );
      await draftRelease(organization, repo, version, plan, {
        planfile,
      });
      break;
    }

    case "apply": {
      const { files, version } = await fetchRelease(organization, repo);
      if (!files || files.length === 0) {
        throw new Error(`No release assets on version ${version}`);
      }
      await terraformApply(organization, repo, files["planfile"]);
      await postrelease(organization, repo);
      break;
    }

    case "terraform": {
      const command = core.getInput("command", { required: true });
      console.log(`Running terraform command: \`terraform ${command}\``);
      await exec(organization, `terraform ${command}`);
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  const tfOutput = await terraformOutput(organization);
  console.log("Output from Terraform:\n", JSON.stringify(tfOutput, null, 2));

  core.setOutput("terraform-output", tfOutput);
  if (tfOutput.github_matrix_include) {
    core.setOutput("matrix", { include: tfOutput.github_matrix_include });
  }
};

(async () => {
  try {
    await run();
  } catch (e) {
    console.error(e);
    core.setFailed(e.message);
  }
})();
