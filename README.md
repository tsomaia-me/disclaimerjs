A CLI tool to bundle dependency licenses and notices into a single file.

## Installation
Globally:

    npm install -g disclaim

Locally (as a dev-dependency):

    npm install --save-dev disclaim

## Usage

Basic usage:

    disclaim --reporting --txt --remote="https://raw.githubusercontent.com/[repositoryOwner]/[repositoryName]/[branch]/[filePath]"

The command above would generate _ThirdPartyLicenses.txt_ file.

When license text wouldn't be found locally, it would use the **url template** specified by **--remote**.

Also, because of **--reporting** flag, it would report about non-found license texts, auto-generated license texts, etc.

For more detailed API explanation, see API section.

## API

- --out - (optional) Can be used to specify a custom name/path for output file (relative to **--dir** or current working directory),
          the default is: ThirdPartyLicenses.json, ThirdPartyLicenses.csv or ThirdPartyLicenses.txt
          for --json, --csv and --txt formats respectively.

- --dir - (optional) Can be used to specify a custom root directory.
          The default is the current working directory.
          Also, note that, package.json in the root directory will be ignored.

- --cacheDir - (optional) Can be used to specify a custom cache directory, the default is .disclaimer

- --remote - (optional) Can be used to specify **url template**, which will be resolved and used for
             downloading licenses from the cloud.
             The template may accept several parameters/placeholders - enclosed in brackets.
    - [packageName] - will be replaced by a package name.
    - [version] - will be replaced by a package version.
    - [repositoryOwner] - will be replaced by a repository owner.
    - [repositoryName] - will be replaced by a repository name.
    - [branch] - will be replaced by a branch name.
    - [filePath] - will be replaced by a requested file path.

- --registry - (optional) Can be used to specify a custom package registry,
               The default registry is: https://registry.npmjs.org/
               
- --ignorePackages - (optional) Comma separated list of packages or package id-s
                     (e.g.: disclaimer or disclaimer@1.0.0) to ignore.
                     
- --ignorePaths - (optional) Comma separated paths (relative to **--dir** or current working directory) to ignore.

- --json - (optional) Output data as json (the default is false):
            
        [
              {
                "name": "",
                "version": "",
                "author": "",
                "repositoryUrl": "",
                "licenseText": "",
                "noticeText": "",
                "thirdPartyNoticeText": ""
              },
        ]

- --csv - (optional) Output data as csv (the default is false):
          
      "name","version","author","repositoryUrl","licenseText","noticeText","thirdPartyNoticeText"
      "","","","","","",""
      
- --txt - (optional) Output data as text (.txt) (the default is true).

- --prepend - (optional) (only for --text) Can be used to specify file name/path
                        - relative to **--dir** or current working directory -
                        to prepend its content to the generated output.

- --append - (optional) (only for --text) Can be used to specify file name/path
                        - relative to **--dir** or current working directory -
                        to append its content to the generated output.

- --reporting - (optional) Can be used to enable reporting of warnings/notices, the default is false.

- --forceFresh - (optional) Forces to ignore a cache.

## Disclaimer

The generated content may not be completely accurate and/or comprehensive.

## License

The software is licensed under MIT No Attribution License (MIT-0),
so, you are not obliged to give attribution when using/redistributing software.

In case it's important, MIT No Attributtion License (MIT-0) is OSI-Approved: [MIT-0](https://opensource.org/licenses/MIT-0)
