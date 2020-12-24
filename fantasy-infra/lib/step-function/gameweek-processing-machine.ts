import * as cdk from '@aws-cdk/core';
import * as stepFunctions from '@aws-cdk/aws-stepfunctions';
import * as stepFunctionTasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda';
import * as targets from '@aws-cdk/aws-events-targets';
import * as events from '@aws-cdk/aws-events';
import * as sns from '@aws-cdk/aws-sns';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as s3 from '@aws-cdk/aws-s3';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as cwActions from '@aws-cdk/aws-cloudwatch-actions';
import { HasGameweekCompletedLambda } from '../lambda/has-gameweek-completed-lambda';
import { ExtractGameweekDataLambda } from '../lambda/extract-gameweek-data-lambda';
import { AssignGameweekBadgesLambda } from '../lambda/assign-gameweek-badges-lambda';
import { AssignSeasonBadgesLambda } from '../lambda/assign-season-badges-lambda';
import { GameweekProcessingCompletedEmailLambda } from '../lambda/gameweek-processing-completed-email-lambda';

export interface GameweekProcessingMachineProps {
    gameweekCompletedTopic: sns.Topic;
    seasonCompletedTopic: sns.Topic;
    leagueDetailsTable: ddb.Table;
    gameweeksTable: ddb.Table;
    badgeTable: ddb.Table;
    gameweekPlayerHistoryTable: ddb.Table;
    staticContentBucket: s3.Bucket;
    errorTopic: sns.Topic;
    mediaAssetsBucket: s3.Bucket;
    emailSubscriptionTable: ddb.Table;
}
export class GameweekProcessingMachine extends cdk.Construct{

    hasGameweekCompletedLambda: lambda.Function;
    extractGameweekDataLambda: lambda.Function;
    gameweekBadgeLambdas: lambda.Function[];
    seasonBadgeLambdas: lambda.Function[];
    gameweekProcessingCompletedEmailLambda: lambda.Function;

    constructor(scope: cdk.Construct, id: string, props: GameweekProcessingMachineProps) {
        super(scope, id);
        this.createLambdas(props);

        const noGameweekDataTopic = new sns.Topic(this, "NoGameweekUpdate", {
            topicName: "NoGameweekDataTopic"
        });

        const hasGameweekCompletedTask = new stepFunctions.Task(this, "HasGameweekCompletedPoller", {
            task: new stepFunctionTasks.InvokeFunction(this.hasGameweekCompletedLambda),
            timeout: cdk.Duration.minutes(3),
            comment: "Checks if the gameweek has completed"
        });

        const hasGameweekCompletedChoice = new stepFunctions.Choice(this, "HasGameweekCompletedChoice", {
            comment: "Checks the hasCompleted flag and if true, sends the state machine towards ETL process"
        });
        
        const gameweekCompletedPublishTask = new stepFunctionTasks.SnsPublish(this, "GameweekCompletedNotification", {
            message: {
                type: stepFunctions.InputType.OBJECT,
                value: stepFunctions.TaskInput.fromDataAt("$")
            },
            topic: props.gameweekCompletedTopic,
            comment: "Publish notification of gameweek completed to gameweek completed topic",
            subject: "Gameweek Completed",
            resultPath: stepFunctions.JsonPath.DISCARD
        });

        const noGameweekDataPublishTask = new stepFunctionTasks.SnsPublish(this, "NoGameweekDataTask", {
            message: {
                type: stepFunctions.InputType.OBJECT,
                value: stepFunctions.TaskInput.fromDataAt("$")
            },
            topic: noGameweekDataTopic,
            comment: "Publish notification that there is no gameweek data",
            subject: "No Gameweek Data",
            resultPath: stepFunctions.JsonPath.DISCARD
        });

        const extractGameweekDataTask = new stepFunctions.Task(this, "ExtractGameweekData", {
            task: new stepFunctionTasks.InvokeFunction(this.extractGameweekDataLambda),
            timeout: cdk.Duration.minutes(5),
            comment: "Extracts and stores data from FPL for processing"
        });

        const parallelGameweekBadgeProcessor = new stepFunctions.Parallel(this, "GameweekBadgeProcessors", {
            resultPath: stepFunctions.JsonPath.DISCARD
        });
        for (let i in this.gameweekBadgeLambdas) {
            let gameweekBadgeLambda = this.gameweekBadgeLambdas[i];
            let constructId = "Processor" + i;
            let stepFunctionTask = new stepFunctions.Task(this, constructId, {
                task: new stepFunctionTasks.InvokeFunction(gameweekBadgeLambda),
                timeout: cdk.Duration.minutes(10)
            });
            stepFunctionTask.addPrefix(gameweekBadgeLambda.functionName);
            parallelGameweekBadgeProcessor.branch(stepFunctionTask);
        }

        const sendGameweekProcessingCompleteEmailTask = new stepFunctions.Task(this, "GameweekCompletedEmail", {
            task: new stepFunctionTasks.InvokeFunction(this.gameweekProcessingCompletedEmailLambda),
            timeout: cdk.Duration.minutes(5),
            comment: "Sends email notification of the gameweek processing completed",
            resultPath: stepFunctions.JsonPath.DISCARD
        });

        const hasSeasonCompletedChoice = new stepFunctions.Choice(this, "HasSeasonCompletedChoice", {
            comment: "Checks the gameweek value and if 38, begins season completed processing",
        });

        const seasonCompletedPublishTask = new stepFunctionTasks.SnsPublish(this, "SeasonCompletedNotification", {
            message: {
                type: stepFunctions.InputType.OBJECT,
                value: stepFunctions.TaskInput.fromDataAt("$")
            },
            topic: props.seasonCompletedTopic,
            comment: "Publish notification of season completed to season completed topic",
            subject: "Season Completed",
            resultPath: stepFunctions.JsonPath.DISCARD
        });

        const parallelSeasonBadgeProcessor = new stepFunctions.Parallel(this, "SeasonBadgeProcessors", {
            resultPath: stepFunctions.JsonPath.DISCARD
        });
        for (let i in this.seasonBadgeLambdas) {
            let seasonBadgeLambda = this.seasonBadgeLambdas[i];
            let constructId = "SeasonProcessor" + i;
            let stepFunctionTask = new stepFunctions.Task(this, constructId, {
                task: new stepFunctionTasks.InvokeFunction(seasonBadgeLambda),
                timeout: cdk.Duration.minutes(10)
            });
            stepFunctionTask.addPrefix(seasonBadgeLambda.functionName);
            parallelSeasonBadgeProcessor.branch(stepFunctionTask);
        }

        hasGameweekCompletedTask.next(hasGameweekCompletedChoice);
        hasGameweekCompletedChoice.when(stepFunctions.Condition.booleanEquals("$.hasCompleted", true), gameweekCompletedPublishTask);
        hasGameweekCompletedChoice.when(stepFunctions.Condition.booleanEquals("$.hasCompleted", false), noGameweekDataPublishTask);
        gameweekCompletedPublishTask.next(extractGameweekDataTask);
        // Uncomment to make testing easier
        // noGameweekDataPublishTask.next(extractGameweekDataTask);
        extractGameweekDataTask.next(parallelGameweekBadgeProcessor);
        parallelGameweekBadgeProcessor.next(sendGameweekProcessingCompleteEmailTask);
        sendGameweekProcessingCompleteEmailTask.next(hasSeasonCompletedChoice);
        const hasSeasonCompletedCondition = stepFunctions.Condition.or(
            stepFunctions.Condition.stringEquals("$.gameweek", "38"),
            stepFunctions.Condition.booleanEquals("$.shouldOverrideSeasonCompletedChoice", true));
        hasSeasonCompletedChoice.when(hasSeasonCompletedCondition, seasonCompletedPublishTask);
        hasSeasonCompletedChoice.when(stepFunctions.Condition.not(hasSeasonCompletedCondition), new stepFunctions.Succeed(this, "SeasonDidNotCompleteSoSkipToEnd"));
        seasonCompletedPublishTask.next(parallelSeasonBadgeProcessor);

        const stateMachine = new stepFunctions.StateMachine(this, "GameweekProcessingStateMachine", {
            stateMachineName: "GameweekProcessingMachine",
            definition: hasGameweekCompletedTask,
            stateMachineType: stepFunctions.StateMachineType.STANDARD
        });

        const alarm = new cw.Alarm(this, 'StepFunctionFailureAlarm', {
            metric: stateMachine.metricFailed(),
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cw.TreatMissingData.MISSING
        });
        alarm.addAlarmAction(new cwActions.SnsAction(props.errorTopic));

        const stateMachineTarget = new targets.SfnStateMachine(stateMachine);

        new events.Rule(this, "CloudWatchEventTrigger", {
            ruleName: "GameweekProcessingCloudWatchEventTrigger",
            schedule: events.Schedule.cron({
            minute: "0",
            hour: "14",
            day: "1/1"
            }),
            description: "CloudWatch rule to run daily to check if gameweek has completed",
            targets: [stateMachineTarget]
        });
    }

    createLambdas(props: GameweekProcessingMachineProps): void {

        this.hasGameweekCompletedLambda = new HasGameweekCompletedLambda(this, "HasGameweekCompletedLambda", {
            leagueDetailsTable: props.leagueDetailsTable,
            gameweeksTable: props.gameweeksTable,
        });
    
        this.extractGameweekDataLambda = new ExtractGameweekDataLambda(this, "ExtractGameweekDataLambda", {
            gameweeksTable: props.gameweeksTable,
            leagueDetailsTable: props.leagueDetailsTable,
            badgeTable: props.badgeTable,
            gameweekPlayerHistoryTable: props.gameweekPlayerHistoryTable,
            staticContentBucket: props.staticContentBucket,
        });
    
        const gameweekBadgeMetadatas = [
            {
                functionName: "AssignGWPlayerStatBadges",
                handler: "controller/gameweek-processing-controller.assignGameweekPlayerStatBadgesHandler",
                description: "Assigns badges based on player stats for the gameweek"
            },
            {
                functionName: "AssignGWMVPBadge",
                handler: "controller/gameweek-processing-controller.assignGameweekMVPBadgeHandler",
                description: "Assigns badges based on MVP data for the gameweek"
            },
            {
                functionName: "AssignGWStandingsBadges",
                handler: "controller/gameweek-processing-controller.assignGameweekStandingsBadgesHandler",
                description: "Assigns badges based on standings for the gameweek"
            }
        ];
        this.gameweekBadgeLambdas = [];
        for (let i in gameweekBadgeMetadatas) {
            let gameweekBadgeMetadata = gameweekBadgeMetadatas[i];
            let constructId = "GameweekAssignBadgeLambda" + i;
            this.gameweekBadgeLambdas.push(new AssignGameweekBadgesLambda(this, constructId, {
                gameweeksTable: props.gameweeksTable,
                leagueDetailsTable: props.leagueDetailsTable,
                badgeTable: props.badgeTable,
                gameweekPlayerHistoryTable: props.gameweekPlayerHistoryTable,
                staticContentBucket: props.staticContentBucket,
                functionName: gameweekBadgeMetadata.functionName,
                description: gameweekBadgeMetadata.description,
                handler: gameweekBadgeMetadata.handler
            }));
        }

        const seasonBadgeMetadatas = [
            {
                functionName: "AssignLeagueAwardsBadges",
                handler: "controller/season-processing-controller.assignLeagueAwardsHandler",
                description: "Assigns badges based on the league awards such as POTY and YPOTY"
            },
            {
                functionName: "AssignPlayerAwardsBadges",
                handler: "controller/season-processing-controller.assignPlayerAwardsHandler",
                description: "Assigns badges based on awards such as golden glove, golden boot, etc for players"
            },
            {
                functionName: "AssignPlayerPointsAwardsBadges",
                handler: "controller/season-processing-controller.assignPlayerPointsAwardsHandler",
                description: "Assigns badges based on the points earned by the players you own for the season"
            },
            {
                functionName: "AssignTeamPointsAwardsBadges",
                handler: "controller/season-processing-controller.assignTeamPointsAwardsHandler",
                description: "Assigns badges based on points a team earns for the season"
            },
            {
                functionName: "AssignTeamStatisticsAwardsBadges",
                handler: "controller/season-processing-controller.assignTeamStatisticsAwardsHandler",
                description: "Assigns badges based on the statistic for a team for the season like yellow and red cards, goals, assists, etc"
            },
            {
                functionName: "AssignTransactionsAwardsBadges",
                handler: "controller/season-processing-controller.assignTransactionsAwardsHandler",
                description: "Assigns badges based on transaction data for the season"
            }
        ];

        this.seasonBadgeLambdas = [];
        for (let i in seasonBadgeMetadatas) {
            let seasonBadgeMetadata = seasonBadgeMetadatas[i];
            let constructId = "SeasonAssignBadgeLambda" + i;
            this.seasonBadgeLambdas.push(new AssignSeasonBadgesLambda(this, constructId, {
                gameweeksTable: props.gameweeksTable,
                leagueDetailsTable: props.leagueDetailsTable,
                badgeTable: props.badgeTable,
                gameweekPlayerHistoryTable: props.gameweekPlayerHistoryTable,
                staticContentBucket: props.staticContentBucket,
                functionName: seasonBadgeMetadata.functionName,
                description: seasonBadgeMetadata.description,
                handler: seasonBadgeMetadata.handler
            }));
        }

        this.gameweekProcessingCompletedEmailLambda = new GameweekProcessingCompletedEmailLambda(this, "GameweekCompletedEmailLambda", {
            gameweeksTable: props.gameweeksTable,
            leagueDetailsTable: props.leagueDetailsTable,
            badgeTable: props.badgeTable,
            gameweekPlayerHistoryTable: props.gameweekPlayerHistoryTable,
            staticContentBucket: props.staticContentBucket,
            functionName: "GameweekProcessingCompletedEmailLambda",
            description: "Controller for email sent after gameweek processing has completed",
            handler: "controller/email-controller.sendGameweekProcessingCompletedEmailController",
            mediaAssetsBucket: props.mediaAssetsBucket,
            emailSubscriptionTable: props.emailSubscriptionTable
        });
    }
}
