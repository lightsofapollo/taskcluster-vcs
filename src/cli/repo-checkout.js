import { ArgumentParser, RawDescriptionHelpFormatter } from 'argparse';
import checkout from './checkout';
import fs from 'mz/fs';
import fsPath from 'path';
import urlAlias from '../vcs/url_alias';
import createHash from '../hash';
import * as vcsRepo from '../vcs/repo';
import Artifacts from '../artifacts';

const STATS_FILE = '.tc-vcs-cache-stats.json';

export default async function main(config, argv) {
  let parser = new ArgumentParser({
    prog: 'tc-vcs repo-checkout',
    version: require('../../package').version,
    addHelp: true,
    formatterClass: RawDescriptionHelpFormatter,
    description: `
      The primary reason to use this command is to utlize the underlying caches
      which the create-repo-cache command creates. The '.repo' directory will be
      expanded from the cache prior to running your command if avaialble.

      Examples:

        # Clone and cache b2g
        tc-vcs repo-checkout -c './config.sh emulator-kk' b2g https://github.com/mozilla/mozilla-b2g

    `.trim()
  });

  parser.addArgument(['--namespace'], {
    defaultValue: 'tc-vcs.v1.repo-project',
    help: `
      Namespace under Index to query should match the value set in
      create-clone-cache.
    `.trim()
  });

  parser.addArgument(['--force-clone'], {
    action: 'storeTrue',
    defaultValue: false,
    help: 'Clone from remote repository when cached copy is not available'.trim()
  });

  parser.addArgument(['-b', '--branch'], {
    dest: 'branch',
    defaultValue: 'master',
    help: 'branch argument to pass (-b) to repo init'
  });

  parser.addArgument(['-j', '--jobs'], {
    dest: 'concurrency',
    defaultValue: 1,
    help: 'Number of projects to sync in parallel'
  });

  parser.addArgument(['directory'], {
    type: (value) => {
      return fsPath.resolve(value);
    },
    help: 'Target directory which to clone and update'
  });

  parser.addArgument(['baseUrl'], {
    help: 'Base repository to clone',
  });

  parser.addArgument(['manifest'], {
    help: `
      Manifest path or url used to initialize repo.
    `
  });

  parser.addArgument(['headUrl'], {
    help: `
      Head url to fetch changes from. If this value is not given baseUrl is used.
    `,
    nargs: '?'
  });

  parser.addArgument(['headRev'], {
    help: `
      Revision/changeset to pull from the repository. If not given this defaults
      to the "tip"/"master" of the default branch.
    `,
    nargs: '?'
  });

  parser.addArgument(['headRef'], {
    help: `
      Reference on head to fetch this should usually be the same value as
      headRev primarily this may be needed for cases where you are fetching a
      revision from a git branch but must fetch the reference and then proceede
      to checkout the particular revision you want (git generally does not support
      pulling specific revisions only references).

      If not given defaults to headRev.
    `.trim(),
    nargs: '?'
  });

  let args = parser.parseArgs(argv);
  let checkoutArgs = [
    args.directory,
    args.baseUrl,
    args.headUrl,
    args.headRev,
    args.headRef,
  ].filter((v) => {
    // don't include values that are null, etc...
    return !!v;
  });

  if (args.force_clone) {
    checkoutArgs.unshift('--force-clone');
  }

  // Checkout the underlying repository before running repo...
  await checkout(config, checkoutArgs);

  // Initialize the directory with the repo command...
  await vcsRepo.init(args.directory, args.manifest, {
    branch: args.branch,
    repoUrl: config.repoCache.repoUrl,
    repoRevision: config.repoCache.repoRevision
  });

  let artifacts = new Artifacts(config.repoCache);

  // Determine the list of projects...
  let projects = await vcsRepo.list(args.directory);
  let start = Date.now();
  let stats = {
    start: new Date(),
    duration: null,
    projects: {}
  };

  let archivesToExtract = await Promise.all(projects.map(async (project) => {
    let downloadStart = Date.now();
    stats.projects[project.name] = {duration: 0};

    let repoPath =
      fsPath.join(args.directory, '.repo', 'projects', `${project.path}.git`);
    let name = `${urlAlias(project.remote)}/${args.branch}`;
    let namespace = `${args.namespace}.${createHash(name)}`;
    let archiveDetails = {
      projectName: project.name
    };

    // Only attempt to use caches if the project does not already exist.
    if (await fs.exists(repoPath)) {
      stats.projects[project.name].duration += Date.now() - downloadStart;
      return;
    }

    archiveDetails.archivePath =
      await artifacts.downloadIfUnavailable(name, namespace, args.directory);

    stats.projects[project.name].duration += Date.now() - downloadStart;

    return archiveDetails;
  }));

  // Extraction of archives should *not* be done in parallel because of race
  // conditions with writing to the same directories.
  for (let archive of archivesToExtract) {
    // Skip if archive does not exist.  This happens when extracted archive already
    // exists.
    if (!archive) continue;
    // If no archive was downloaded, processing should only continue if force-clone
    // option was specified. This is to prevent accidentally doing full clones of repositories
    // unless explicitly forced.
    if (!archive.archivePath) {
      if (!args.force_clone) {
        console.error(
          `[taskcluster-vcs:error] Cached copy of '${archive.projectName}' could not be found. ` +
          `Use '--force-clone' to perform a full clone`
        );
        process.exit(1);
      }
      continue;
    }

    let extractStart = Date.now();

    await artifacts.extract(archive.archivePath, args.directory);

    stats.projects[archive.projectName].duration += Date.now() - extractStart;
  }

  await vcsRepo.sync(args.directory, { concurrency: args.concurrency });

  stats.duration = Date.now() - start;
  stats.stop = new Date();
  await fs.writeFile(
    fsPath.join(args.directory, '.repo', STATS_FILE),
    JSON.stringify(stats, null, 2)
  );

  if (!await fs.exists(fsPath.join(args.directory, '.repo'))) {
    console.error(`[taskcluster-vcs:error] ${args.command} ran but did not generate a .repo directory`);
    process.exit(1);
  }
}
