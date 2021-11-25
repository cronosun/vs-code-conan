/* eslint-disable eqeqeq */
import { SettingsParser } from "./settings-parser";
import { BuildProfile, Profile, Workspace } from "./profile";
import { autoInjectable, container, inject, singleton } from "tsyringe";
import { stripArgument } from "./argument-parser";
import { System } from "../system/system";
import { ProfileName } from "../commands/vscode-control";

interface ConanProfile {
    build: string | undefined;
    host: string | undefined;
}
export interface WorkspaceArgument {
    installFolder: string | undefined;
    path: string;
    installProfile: ConanProfile;
    installArguments: string | undefined;
}
export interface ConanArgument extends WorkspaceArgument {
    buildFolder: string | undefined;
    user: string;
    channel: string;
    createProfile: ConanProfile | undefined;
    buildArguments: string | undefined;
    createArguments: string | undefined;
}

interface ProfileVariant {
    profileGeneric: string | undefined;
    profileSpecific: ConanProfile;
}
interface installArgumentsExtracted {
    installArg: string | undefined;
    profile: ProfileVariant;
    installFolder: string | undefined;
}

@autoInjectable()
export class Configurator {
    private readonly file: string;
    // Hab hier mal nen alias hinzugefügt. Ich nehme an der key ist ein ProfileName oder so was
    // (rein zu dokumentationszwecken wenn man den code liest; sieht man schneller was was ist).
    //
    // weiterer vorteil: Man kann auch danach suchen im Projekt. Schauen wo dieser Profile-name
    // überall verwendet wird.
    private profiles: Map<ProfileName, Profile> | undefined;
    // der String hier, ist das auch ProfileName oder ein WorkspaceName oder so was?
    private workspaces: Map<string, Workspace> | undefined;
    private system:System;

    constructor(file: string) {
        this.file = file;
        this.system=container.resolve("System");
        this.update();
    }

    update() {
        let data = this.system.readFile(this.file);
        let parser = new SettingsParser(data);
        this.profiles = parser.getProfiles();
        this.workspaces = parser.getWorkspaces();
    }

    private getConsoleProfile(strippedInstallArg: ProfileVariant, name: string): ConanProfile {
        let installProfile;
        if (strippedInstallArg.profileGeneric === undefined
            && strippedInstallArg.profileSpecific.build === undefined
            && strippedInstallArg.profileSpecific.host === undefined) {
            installProfile = this.getProfiles(name);
        }
        else {
            installProfile = this.convertProfile(strippedInstallArg.profileGeneric, strippedInstallArg.profileSpecific);
        }
        return installProfile;
    }

    private stripProfilesArg(argument: string): { argument: string, profile: ProfileVariant } {
        let argStripped = stripArgument(argument, "pr:b", "profile:build");
        let installBuildProfile = argStripped.foundValue;
        argStripped = stripArgument(argStripped.stripedArgument, "pr:h", "profile:host");
        let installHostProfile = argStripped.foundValue;
        argStripped = stripArgument(argStripped.stripedArgument, "pr", "profile");
        let profileGeneric = argStripped.foundValue;
        let profile: ProfileVariant = { profileGeneric, profileSpecific: { build: installBuildProfile, host: installHostProfile } };
        return { argument: argStripped.stripedArgument, profile };
    }

    private stripInstallArg(profile: Profile | Workspace): installArgumentsExtracted {
        let installArgRaw;
        if(profile instanceof Profile){
            installArgRaw = profile.installArg;
        }
        else{
            installArgRaw = profile.arg;
        }
        let parsedProfile = this.stripProfilesArg(installArgRaw);
        let installArg = stripArgument(parsedProfile.argument, "if", "install-folder");
        let installFolder = installArg.foundValue;
        let stripedArgument = installArg.stripedArgument;
        return { installArg: stripedArgument, profile: parsedProfile.profile, installFolder };
    }

    private stripCreateArg(profile: Profile) {
        let parsedProfile = this.stripProfilesArg(profile.createArg);
        return { createArg: parsedProfile.argument, profile: parsedProfile.profile };
    }

    private stripBuildArg(profile: Profile) {
        let buildArg = stripArgument(profile.buildArg, "bf", "build-folder");
        return { buildArg: buildArg.stripedArgument, buildFolder: buildArg.foundValue };
    }

    private appendKeysOfMap(array: Array<string>, map: Map<string, Profile | Workspace> | undefined): Array<string> {
        if (map) {
            array = array.concat(Array.from(map.keys()));
        }
        return array;
    }

    private checkUniqueName(names: string[]): boolean {
        return new Set(names).size !== names.length;
    }

    private convertProfile(profileGeneric: string | undefined, profileSpecific: ConanProfile) {
        if (profileGeneric && (profileSpecific.build || profileSpecific.host)) {
            throw new Error("Can't define profile with profile-host or profile-build.");
        }
        if (profileSpecific.build || profileSpecific.host) {
            let profileBuild = this.replaceUndefinedDefault(profileSpecific.build);
            let profileHost = this.replaceUndefinedDefault(profileSpecific.host);
            return { build: profileBuild, host: profileHost };
        }
        else {
            let profile = this.replaceUndefinedDefault(profileGeneric);
            return { build: profile, host: profile };
        }
    }

    private getProfiles(name: string): ConanProfile {
        let profileConfig: BuildProfile = this.getProfileConfiguration(name);
        return this.convertProfile(profileConfig.profile, { build: profileConfig.profileBuild, host: profileConfig.profileHost });
    }

    private getBuildFolder(name: string): string | undefined {
        let profileConfig: BuildProfile = this.getProfileConfiguration(name);
        // hier: dünkt mich sollte "Uri" anstatt "string" sein
        return profileConfig.buildFolder;
    }

    // Neu: "name: ProfileName": Generell: Würde etwas mehr type-aliases verwenden, so rein zu
    // zu dokumentationszwecken, dann sieht man besser was was ist.
    //
    // habs mal nur dieser methode hinzugefügt...
    private getProfileConfiguration(name: ProfileName) {
        let profileConfig:BuildProfile;
        if (this.profiles?.has(name)) {
            profileConfig = <BuildProfile>this.profiles.get(name);
        }
        else if (this.workspaces?.has(name)) {
            profileConfig = <BuildProfile>this.workspaces.get(name);
        }
        else {
            throw new Error("The profile configuration does not exist - " + name);
        }
        return profileConfig;
    }

    private replaceUndefinedDefault(value: string | undefined): string {
        if (value === undefined) {
            return "default";
        }
        return value;
    }

    getWorkspace(name: string):WorkspaceArgument{
        let workspace = this.workspaces?.get(name);
        if (workspace) {
            let strippedInstallArgument = this.stripInstallArg(workspace);
            let instProfile = this.getConsoleProfile(strippedInstallArgument.profile, name);
            let installFolder = strippedInstallArgument.installFolder ? strippedInstallArgument.installFolder : this.getBuildFolder(name);
            let workspaceArg:WorkspaceArgument = {
                path: workspace.conanworkspacePath,
                installProfile: instProfile,
                installArguments: strippedInstallArgument.installArg,
                installFolder: installFolder
            };
            return workspaceArg;
        }
        throw Error("No workspace found with this name "+name+".");

    }
    getConan(name: string): ConanArgument {
        let profile = this.profiles?.get(name);
        if (profile) {
            let strippedInstallArg = this.stripInstallArg(profile);
            let installProfile = this.getConsoleProfile(strippedInstallArg.profile, name);
            let strippedBuildArg = this.stripBuildArg(profile);
            let strippedCreateArg = this.stripCreateArg(profile);
            let createProfile = this.getConsoleProfile(strippedCreateArg.profile, name);
            let buildFolder = strippedBuildArg.buildFolder ? strippedBuildArg.buildFolder : this.getBuildFolder(name);
            let installFolder = strippedInstallArg.installFolder ? strippedInstallArg.installFolder : this.getBuildFolder(name);
            let conanArg: ConanArgument = {
                path: profile.conanfilePath,
                user: profile.createUser,
                channel: profile.createChannel,
                installProfile: installProfile,
                installArguments: strippedInstallArg.installArg,
                createArguments: strippedCreateArg.createArg,
                buildArguments: strippedBuildArg.buildArg,
                buildFolder: buildFolder,
                createProfile: createProfile,
                installFolder: installFolder
            };
            return conanArg;
        }
        throw Error("No profile found with this name "+name+".");

    }

    getAllNames(): string[] {
        let names: Array<string> = new Array<string>();
        names = this.appendKeysOfMap(names, this.profiles);
        names = this.appendKeysOfMap(names, this.workspaces);
        if (this.checkUniqueName(names)) {
            throw new Error("Duplication of names in profile and workspace");
        }
        return names;
    }

    isWorkspace(name: string): boolean {
        if (this.workspaces){
            return this.workspaces.has(name);
        }
        return false;
    }
}
