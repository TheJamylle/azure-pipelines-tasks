import fs = require('fs');
import path = require('path');
import tl = require('azure-pipelines-task-lib/task');

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryLogic(retryCount: number, callback: () => void, opName: string, delayBetweenRetries: number) {
    let attempts = retryCount;
    while (true) {
        try {
            await callback();
            break;
        }
        catch (err) {
            console.log(`Error while ${opName}: ${err}. Remaining attempts: ${attempts}`);
            --attempts;
            if (attempts <= 0) {
                throw err;
            }
            await sleep(delayBetweenRetries); 
        }
    }
}

async function main() {
    // we allow broken symlinks - since there could be broken symlinks found in source folder, but filtered by contents pattern
    const findOptions: tl.FindOptions = {
        allowBrokenSymbolicLinks: true,
        followSpecifiedSymbolicLink: true,
        followSymbolicLinks: true
    };

    tl.setResourcePath(path.join(__dirname, 'task.json'));

    // contents is a multiline input containing glob patterns
    let contents: string[] = tl.getDelimitedInput('Contents', '\n', true);
    let sourceFolder: string = tl.getPathInput('SourceFolder', true, true);
    let targetFolder: string = tl.getPathInput('TargetFolder', true);
    let cleanTargetFolder: boolean = tl.getBoolInput('CleanTargetFolder', false);
    let overWrite: boolean = tl.getBoolInput('OverWrite', false);
    let flattenFolders: boolean = tl.getBoolInput('flattenFolders', false);
    let retryCount: number = parseInt(tl.getInput('retryCount'));
    let delayBetweenRetries: number = parseInt(tl.getInput('delayBetweenRetries'));
    if (isNaN(retryCount) || retryCount < 0) {
        retryCount = 0;
    }

    if (isNaN(delayBetweenRetries) || delayBetweenRetries < 0) {
        delayBetweenRetries = 0;
    }

    const preserveTimestamp: boolean = tl.getBoolInput('preserveTimestamp', false);

    // normalize the source folder path. this is important for later in order to accurately
    // determine the relative path of each found file (substring using sourceFolder.length).
    sourceFolder = path.normalize(sourceFolder);
    let allPaths: string[] = tl.find(sourceFolder, findOptions);
    let sourceFolderPattern = sourceFolder.replace('[', '[[]'); // directories can have [] in them, and they have special meanings as a pattern, so escape them
    let matchedPaths: string[] = tl.match(allPaths, contents, sourceFolderPattern); // default match options
    let matchedFiles: string[] = matchedPaths.filter((itemPath: string) => !tl.stats(itemPath).isDirectory()); // filter-out directories

    // copy the files to the target folder
    console.log(tl.loc('FoundNFiles', matchedFiles.length));

    if (matchedFiles.length > 0) {
        // clean target folder if required
        if (cleanTargetFolder) {
            console.log(tl.loc('CleaningTargetFolder', targetFolder));

            // stat the targetFolder path
            let targetFolderStats: tl.FsStats;
            try {
                let attempts = retryCount;
                while (true) {
                    try {
                        targetFolderStats = tl.stats(targetFolder);
                        break;
                    }
                    catch (err) {
                        if (err.code != 'ENOENT') {
                            console.log(`Error while stats ${targetFolder}: ${err}. Remaining attempts: ${attempts}`);
                            --attempts;
                            if (attempts <= 0) {
                                throw err;
                            }
                            await sleep(delayBetweenRetries); 
                        } else{
                            break;
                        }
                    }
                }
            }
            catch (err) {
                if (err.code != 'ENOENT') {
                    throw err;
                }
            }

            if (targetFolderStats) {
                if (targetFolderStats.isDirectory()) {
                    // delete the child items
                    await retryLogic(retryCount, async () => {
                        const dirItems = fs.readdirSync(targetFolder);
                        for (let item of dirItems) {
                            let itemPath = path.join(targetFolder, item);
                            await retryLogic(retryCount, () => {
                                tl.rmRF(itemPath);
                            }, `removing of ${itemPath}`, delayBetweenRetries);
                        }
                    }, `reading of ${targetFolder}`, delayBetweenRetries)
                }
                else {
                    // targetFolder is not a directory. delete it.
                    await retryLogic(retryCount, () => {
                        tl.rmRF(targetFolder);
                    }, `removing of ${targetFolder}`, delayBetweenRetries)
                }
            }
        }
        await retryLogic(retryCount, () => {
            tl.mkdirP(targetFolder);
        }, `mkDir of ${targetFolder}`, delayBetweenRetries)
        // make sure the target folder exists

        let attempts = retryCount;
        while (true) {
            try {
                let createdFolders: { [folder: string]: boolean } = {};
                matchedFiles.forEach(async (file: string) => {
                    let relativePath;
                    if (flattenFolders) {
                        relativePath = path.basename(file);
                    } else {
                        relativePath = file.substring(sourceFolder.length);

                        // trim leading path separator
                        // note, assumes normalized above
                        if (relativePath.startsWith(path.sep)) {
                            relativePath = relativePath.substr(1);
                        }
                    }

                    let targetPath = path.join(targetFolder, relativePath);
                    let targetDir = path.dirname(targetPath);

                    if (!createdFolders[targetDir]) {
                        await retryLogic(retryCount, () => {
                            tl.mkdirP(targetDir);
                        }, `mkDir of ${targetFolder}`, delayBetweenRetries)

                        createdFolders[targetDir] = true;
                    }

                    // stat the target
                    let targetStats: tl.FsStats;
                    if (!cleanTargetFolder) { // optimization - no need to check if relative target exists when CleanTargetFolder=true
                        try {
                            let attempts = retryCount;
                            while (true) {
                                try {
                                    targetStats = tl.stats(targetPath);
                                    break;
                                }
                                catch (err) {
                                    if (err.code != 'ENOENT') {
                                        console.log(`Error while stats ${targetPath}: ${err}. Remaining attempts: ${attempts}`);
                                        --attempts;
                                        if (attempts <= 0) {
                                            throw err;
                                        }
                                        await sleep(delayBetweenRetries); 
                                    } else{
                                        break;
                                    }
                                }
                                
                            }
                        }
                        catch (err) {
                            if (err.code != 'ENOENT') {
                                throw err;
                            }
                        }
                    }

                    // validate the target is not a directory
                    if (targetStats && targetStats.isDirectory()) {
                        throw new Error(tl.loc('TargetIsDir', file, targetPath));
                    }

                    if (!overWrite) {
                        if (targetStats) { // exists, skip
                            console.log(tl.loc('FileAlreadyExistAt', file, targetPath));
                        }
                        else { // copy
                            console.log(tl.loc('CopyingTo', file, targetPath));
                            tl.cp(file, targetPath, undefined, undefined, retryCount);
                            if (preserveTimestamp) {
                                try {
                                    let fileStats;
                                    let attempts = retryCount;
                                    while (true) {
                                        try {
                                            fileStats = tl.stats(file);
                                            break;
                                        }
                                        catch (err) {
                                            console.log(`Error while stats ${file}: ${err}. Remaining attempts: ${attempts}`);
                                            --attempts;
                                            if (attempts <= 0) {
                                                throw err;
                                            }
                                            await sleep(delayBetweenRetries);
                                        }
                                    }
                                    fs.utimes(targetPath, fileStats.atime, fileStats.mtime, (err) => {
                                        console.warn(`Problem applying the timestamp: ${err}`);
                                    });
                                }
                                catch (err) {
                                    console.warn(`Problem preserving the timestamp: ${err}`)
                                }
                            }
                        }
                    }
                    else {
                        console.log(tl.loc('CopyingTo', file, targetPath));
                        if (process.platform == 'win32' && targetStats && (targetStats.mode & 146) != 146) {
                            // The readonly attribute can be interpreted by performing a bitwise-AND operation on
                            // "fs.Stats.mode" and the integer 146. The integer 146 represents "-w--w--w-" or (128 + 16 + 2),
                            // see following chart:
                            //     R   W  X  R  W X R W X
                            //   256 128 64 32 16 8 4 2 1
                            //
                            // "fs.Stats.mode" on Windows is based on whether the readonly attribute is set.
                            // If the readonly attribute is set, then the mode is set to "r--r--r--".
                            // If the readonly attribute is not set, then the mode is set to "rw-rw-rw-".
                            //
                            // Note, additional bits may also be set (e.g. if directory). Therefore, a bitwise
                            // comparison is appropriate.
                            //
                            // For additional information, refer to the fs source code and ctrl+f "st_mode":
                            //   https://github.com/nodejs/node/blob/v5.x/deps/uv/src/win/fs.c#L1064
                            tl.debug(`removing readonly attribute on '${targetPath}'`);
                            await retryLogic(retryCount, () => {
                                fs.chmodSync(targetPath, targetStats.mode | 146);
                            }, `chmodSync ${targetPath}`, delayBetweenRetries)
                        }

                        tl.cp(file, targetPath, "-f", undefined, retryCount);
                        if (preserveTimestamp) {
                            try {
                                const fileStats: tl.FsStats = tl.stats(file);
                                fs.utimes(targetPath, fileStats.atime, fileStats.mtime, (err) => {
                                    console.warn(`Problem applying the timestamp: ${err}`);
                                });
                            }
                            catch (err) {
                                console.warn(`Problem preserving the timestamp: ${err}`)
                            }
                        }
                    }
                });
                break;
            }
            catch (err) {
                console.log(`Error: ${err}. Remaining attempts: ${attempts}`);
                --attempts;
                if (attempts <= 0) {
                    tl.setResult(tl.TaskResult.Failed, err);
                }
                await sleep(delayBetweenRetries);
            }
            break;
        }
    }
}

main();
